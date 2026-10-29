-- ChessArena — Sprint 3 : anti-triche, dossiers de modération, retraits sous contrôle.
--
-- Séparation des responsabilités :
--   • services/analysis  DÉTECTE : écrit analyses + statistiques par joueur, émet des verdicts ;
--   • apps/game-server   APPLIQUE : seul à modifier l'état des comptes, les dossiers et l'argent.
--
-- Garde-fous en base (défense en profondeur, indépendants du code applicatif) :
--   G1  aucun argent ne peut sortir (`house:psp-out:*`) pour un compte qui n'est pas `active` ;
--   G2  une demande de retrait ne peut passer à `sent` que si son titulaire est `active` ;
--   G3  décisions de modération et analyses : append-only ;
--   G4  un seul dossier ouvert par joueur.

-- Remplacée par les deux tables ci-dessous (jamais alimentée, aucune donnée).
DROP TABLE IF EXISTS anticheat_reports;

ALTER TABLE users ADD COLUMN fairplay_watch BOOLEAN NOT NULL DEFAULT FALSE;

-- ════════════════════════════════════════════════════════════════════════════
-- Analyses moteur
-- ════════════════════════════════════════════════════════════════════════════
-- Une partie peut être analysée à plusieurs profondeurs (triage 12, puis confirmation 18–20).
CREATE TABLE anticheat_analyses (
  game_id     UUID NOT NULL REFERENCES games(id),
  depth       INT  NOT NULL CHECK (depth BETWEEN 1 AND 60),
  engine      TEXT NOT NULL,                 -- version exacte : un rapport doit être rejouable
  request     JSONB NOT NULL,                -- requête d'origine (PGN, temps, focus) : permet la réanalyse
  moves       JSONB NOT NULL,                -- détail par demi-coup (évals, meilleur coup, perte, temps, inclusion)
  duration_ms INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, depth)
);
CREATE TRIGGER anticheat_analyses_immutable BEFORE UPDATE OR DELETE ON anticheat_analyses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE anticheat_player_stats (
  game_id           UUID NOT NULL,
  depth             INT  NOT NULL,
  user_id           TEXT NOT NULL REFERENCES users(id),
  color             CHAR(1) NOT NULL CHECK (color IN ('w', 'b')),
  rating            INT NOT NULL,
  currency          currency NOT NULL,
  time_control      TEXT NOT NULL,
  analysed_moves    INT NOT NULL,
  acpl              NUMERIC(7,2) NOT NULL,
  engine_match_rate NUMERIC(5,4) NOT NULL,
  time_mean_ms      DOUBLE PRECISION NOT NULL,
  time_variance     DOUBLE PRECISION NOT NULL,  -- ms²
  time_cv           DOUBLE PRECISION NOT NULL,  -- écart-type / moyenne (sans unité, comparable entre cadences)
  focus_loss        INT NOT NULL,
  game_ended_at     TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, depth, user_id),
  FOREIGN KEY (game_id, depth) REFERENCES anticheat_analyses (game_id, depth)
);
CREATE INDEX anticheat_player_stats_user_idx ON anticheat_player_stats (user_id, game_ended_at DESC);
CREATE TRIGGER anticheat_player_stats_immutable BEFORE UPDATE OR DELETE ON anticheat_player_stats FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ════════════════════════════════════════════════════════════════════════════
-- Dossiers et décisions
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE anticheat_cases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  level            TEXT NOT NULL CHECK (level IN ('watch', 'hold')),   -- gravité courante (ne fait que monter)
  score            INT  NOT NULL,
  reasons          TEXT[] NOT NULL,
  trigger_game_ids UUID[] NOT NULL,
  resolution       TEXT CHECK (resolution IN ('clean', 'watch', 'cheat')),
  resolved_by      TEXT,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (resolution IS NOT NULL))
);
-- G4
CREATE UNIQUE INDEX anticheat_cases_one_open_per_user ON anticheat_cases (user_id) WHERE status = 'open';
CREATE INDEX anticheat_cases_status_idx ON anticheat_cases (status, level, score DESC);

-- Journal des décisions (système ET modérateurs). G3.
CREATE TABLE moderation_decisions (
  id         BIGSERIAL PRIMARY KEY,
  case_id    UUID NOT NULL REFERENCES anticheat_cases(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  actor      TEXT NOT NULL,                 -- 'system:analysis' ou id du modérateur
  action     TEXT NOT NULL CHECK (action IN ('open_watch', 'escalate_hold', 'clean', 'watch', 'cheat')),
  note       TEXT,
  details    JSONB NOT NULL DEFAULT '{}',   -- remboursements, confiscations, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX moderation_decisions_case_idx ON moderation_decisions (case_id, id);
CREATE TRIGGER moderation_decisions_immutable BEFORE UPDATE OR DELETE ON moderation_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ════════════════════════════════════════════════════════════════════════════
-- Retraits
-- ════════════════════════════════════════════════════════════════════════════
-- Statuts internes : requested → sent | on_hold → requested (levée) | cancelled.
-- `on_hold` n'est JAMAIS exposé au joueur : l'API publique l'affiche comme `processing`,
-- exactement comme `requested` (ne pas révéler le dispositif à un tricheur présumé).
CREATE TABLE withdrawal_requests (
  id           UUID PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  currency     currency NOT NULL CHECK (currency = 'EUR'),   -- les jetons PLAY ne se retirent pas
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL CHECK (status IN ('requested', 'on_hold', 'sent', 'cancelled')),
  psp_ref      TEXT UNIQUE,
  hold_reason  TEXT,                         -- interne
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX withdrawal_requests_status_idx ON withdrawal_requests (status, created_at);
CREATE INDEX withdrawal_requests_user_idx ON withdrawal_requests (user_id, created_at DESC);

-- G2 : un retrait ne part que pour un compte actif ; un retrait envoyé ou annulé est définitif.
CREATE OR REPLACE FUNCTION withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st account_state;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'withdrawal_requests is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('sent', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'withdrawal % already final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'sent' AND OLD.status <> 'sent' THEN
    SELECT state INTO st FROM users WHERE id = NEW.user_id;
    IF st <> 'active' THEN
      RAISE EXCEPTION 'withdrawal % blocked: account %', NEW.id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'withdrawal_requires_active_account';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_requests_guard BEFORE UPDATE OR DELETE ON withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION withdrawal_guard();

-- G1 : toute écriture créditant `house:psp-out:*` (argent qui quitte la plateforme) doit
-- appartenir à une transaction comptable rattachée à un retrait (`meta.withdrawalId`)
-- dont le titulaire est `active`. Même un INSERT SQL manuel ne peut pas contourner.
CREATE OR REPLACE FUNCTION ledger_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid TEXT; st account_state;
BEGIN
  IF NEW.account NOT LIKE 'house:psp-out:%' THEN
    RETURN NEW;
  END IF;
  SELECT meta->>'withdrawalId' INTO wid FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF wid IS NULL THEN
    RAISE EXCEPTION 'payout without withdrawal reference' USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_requires_withdrawal';
  END IF;
  SELECT u.state INTO st FROM withdrawal_requests w JOIN users u ON u.id = w.user_id WHERE w.id = wid::uuid;
  IF st IS NULL OR st <> 'active' THEN
    RAISE EXCEPTION 'payout blocked for withdrawal % (account %)', wid, coalesce(st::text, 'unknown')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payout_requires_active_account';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entries_payout_guard BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_payout_guard();
