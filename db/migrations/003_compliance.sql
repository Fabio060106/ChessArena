-- ChessArena — Sprint 4 : KYC/AML, jeu responsable, kill-switch juridictionnel, exports réglementaires.
--
-- Paramètres de jeu responsable alignés sur les obligations des opérateurs agréés ANJ
-- (fiche ANJ « Les limites de jeu sur les sites en ligne ») :
--   • limites de DÉPÔTS et de MISES sur 7 jours glissants, fixées AVANT le 1er dépôt / la 1re mise ;
--   • baisse effective immédiatement, hausse effective après 48 h ;
--   • auto-exclusion de 24 h à 12 mois, ou définitive (fermeture du compte).
--
-- Garde-fous en base (indépendants du code) :
--   G1' sortie d'argent : titulaire KYC `verified` ET état ∈ {active, self_excluded, closed}
--       (un joueur auto-exclu ou clôturé DOIT pouvoir récupérer son solde ; jamais en
--        withdrawal_hold ni suspendu) ;
--   G2' même règle pour le passage d'un retrait à `sent` ;
--   G3  dépôt : titulaire KYC `verified` ET état ∈ {active, withdrawal_hold}.

-- ─── KYC ─────────────────────────────────────────────────────────────────────
ALTER TYPE kyc_status RENAME VALUE 'none' TO 'unverified';
ALTER TABLE users ADD COLUMN kyc_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN kyc_review_required BOOLEAN NOT NULL DEFAULT FALSE; -- alerte AML : revue humaine
ALTER TABLE users ADD COLUMN kyc_verified_at TIMESTAMPTZ;

-- Journal immuable des contrôles d'identité (pas de pièce ni d'image : elles restent chez le prestataire).
CREATE TABLE kyc_events (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  from_status       kyc_status NOT NULL,
  to_status         kyc_status NOT NULL,
  actor             TEXT NOT NULL,                  -- 'provider:<nom>', 'user', id d'un agent conformité
  provider          TEXT,
  provider_ref      TEXT,                           -- identifiant du dossier chez le prestataire
  provider_event_id TEXT UNIQUE,                    -- anti-rejeu des webhooks
  reason            TEXT,                           -- MINOR, DOCUMENT_INVALID, SANCTIONS_HIT…
  checks            JSONB NOT NULL DEFAULT '{}',    -- résultats synthétiques (âge ≥ 18, PEP, sanctions, pays)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kyc_events_user_idx ON kyc_events (user_id, id);
CREATE INDEX kyc_events_created_idx ON kyc_events (created_at);
CREATE TRIGGER kyc_events_immutable BEFORE UPDATE OR DELETE ON kyc_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─── Jeu responsable ─────────────────────────────────────────────────────────
DROP TABLE IF EXISTS responsible_gaming_limits; -- schéma 001 jamais utilisé, remplacé

CREATE TYPE rg_limit_kind AS ENUM ('deposit_week', 'stake_week', 'stake_per_entry');

-- Limite en vigueur + éventuelle hausse en attente (effective à `pending_effective_at`).
CREATE TABLE rg_limits (
  user_id              TEXT NOT NULL REFERENCES users(id),
  kind                 rg_limit_kind NOT NULL,
  amount_cents         BIGINT NOT NULL CHECK (amount_cents > 0),
  pending_amount_cents BIGINT CHECK (pending_amount_cents > 0),
  pending_effective_at TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind),
  CHECK ((pending_amount_cents IS NULL) = (pending_effective_at IS NULL))
);

ALTER TABLE users ADD COLUMN self_excluded_until TIMESTAMPTZ;      -- NULL + state=closed : définitive
ALTER TABLE users ADD COLUMN self_exclusion_permanent BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE rg_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  event      TEXT NOT NULL CHECK (event IN ('limit_set', 'limit_decrease', 'limit_increase_requested', 'limit_increase_applied',
                                           'self_exclusion', 'self_exclusion_ended', 'limit_blocked')),
  kind       rg_limit_kind,
  old_cents  BIGINT,
  new_cents  BIGINT,
  until      TIMESTAMPTZ,
  details    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rg_events_created_idx ON rg_events (created_at);
CREATE INDEX rg_events_user_idx ON rg_events (user_id, id);
CREATE TRIGGER rg_events_immutable BEFORE UPDATE OR DELETE ON rg_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Index pour les cumuls glissants sur 7 jours (dépôts / mises), lus dans la transaction comptable.
CREATE INDEX ledger_transactions_kind_idx ON ledger_transactions ((meta->>'kind'), created_at);
CREATE INDEX ledger_entries_account_created_idx ON ledger_entries (account, created_at);

-- ─── Kill-switch (état runtime, en complément de REAL_MONEY_ENABLED) ─────────
CREATE TABLE compliance_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO compliance_settings (key, value, updated_by)
VALUES ('real_money', '{"enabled": false, "countries": []}', 'migration:003');

CREATE TABLE compliance_events (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER compliance_events_immutable BEFORE UPDATE OR DELETE ON compliance_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─── Exports réglementaires (registre des exports produits) ──────────────────
CREATE TABLE regulatory_exports (
  id              UUID PRIMARY KEY,
  period_from     TIMESTAMPTZ NOT NULL,
  period_to       TIMESTAMPTZ NOT NULL,
  manifest_sha256 CHAR(64) NOT NULL,
  key_fingerprint CHAR(64) NOT NULL,
  generated_by    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to > period_from)
);
CREATE TRIGGER regulatory_exports_immutable BEFORE UPDATE OR DELETE ON regulatory_exports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─── Garde-fous G1' / G2' / G3 ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid TEXT; st account_state; k kyc_status;
BEGIN
  IF NEW.account NOT LIKE 'house:psp-out:%' THEN
    RETURN NEW;
  END IF;
  SELECT meta->>'withdrawalId' INTO wid FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF wid IS NULL THEN
    RAISE EXCEPTION 'payout without withdrawal reference' USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_requires_withdrawal';
  END IF;
  SELECT u.state, u.kyc INTO st, k FROM withdrawal_requests w JOIN users u ON u.id = w.user_id WHERE w.id = wid::uuid;
  IF st IS NULL OR st NOT IN ('active', 'self_excluded', 'closed') THEN
    RAISE EXCEPTION 'payout blocked for withdrawal % (account %)', wid, coalesce(st::text, 'unknown')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_requires_active_account';
  END IF;
  IF k <> 'verified' THEN
    RAISE EXCEPTION 'payout blocked for withdrawal % (kyc %)', wid, k
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_requires_kyc';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st account_state; k kyc_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'withdrawal_requests is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('sent', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'withdrawal % already final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'sent' AND OLD.status <> 'sent' THEN
    SELECT state, kyc INTO st, k FROM users WHERE id = NEW.user_id;
    IF st NOT IN ('active', 'self_excluded', 'closed') THEN
      RAISE EXCEPTION 'withdrawal % blocked: account %', NEW.id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_requires_active_account';
    END IF;
    IF k <> 'verified' THEN
      RAISE EXCEPTION 'withdrawal % blocked: kyc %', NEW.id, k
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_requires_kyc';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- G3 : toute entrée d'argent (`house:psp-in:EUR` débité) doit être rattachée à un dépôt
-- d'un joueur vérifié, non exclu. Vérifié au COMMIT (le compte joueur est écrit dans le même lot).
CREATE OR REPLACE FUNCTION ledger_deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid TEXT; st account_state; k kyc_status;
BEGIN
  IF NEW.account NOT LIKE 'house:psp-in:%' THEN
    RETURN NULL;
  END IF;
  SELECT meta->>'userId' INTO uid FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF uid IS NULL THEN
    RAISE EXCEPTION 'deposit without user reference' USING ERRCODE = 'check_violation', CONSTRAINT = 'deposit_requires_user';
  END IF;
  SELECT state, kyc INTO st, k FROM users WHERE id = uid;
  IF k IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'deposit refused for % (kyc %)', uid, coalesce(k::text, 'unknown')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deposit_requires_kyc';
  END IF;
  IF st NOT IN ('active', 'withdrawal_hold') THEN
    RAISE EXCEPTION 'deposit refused for % (account %)', uid, st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deposit_requires_open_account';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_deposit_guard AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_deposit_guard();
