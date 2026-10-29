-- ChessArena — schéma initial (PostgreSQL ≥ 15)
-- Réécrit au Sprint 2 (aucune base n'était encore déployée). Toute évolution passe
-- désormais par 002_*.sql, 003_*.sql… appliqués par apps/game-server/src/db/migrate.ts.
--
-- Principes :
--   • argent en BIGINT centimes, jamais de float ;
--   • grand livre en partie double, append-only ; les soldes sont un cache maintenu
--     par trigger dans la MÊME transaction que l'écriture ;
--   • étanchéité PLAY / EUR garantie par clés étrangères composites (ADR-6) ;
--   • journaux immuables (UPDATE / DELETE interdits par trigger).

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE currency      AS ENUM ('PLAY', 'EUR');
CREATE TYPE kyc_status    AS ENUM ('none', 'pending', 'verified', 'rejected');
CREATE TYPE account_state AS ENUM ('active', 'withdrawal_hold', 'suspended', 'self_excluded', 'closed');

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════════════════
-- Utilisateurs (id = `sub` du JWT émis par le service d'auth)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE users (
  id               TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  username         TEXT NOT NULL,
  email            CITEXT UNIQUE,
  birth_date       DATE,
  country          CHAR(2),
  kyc              kyc_status NOT NULL DEFAULT 'none',
  state            account_state NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE responsible_gaming_limits (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id),
  deposit_limit_week_cents BIGINT CHECK (deposit_limit_week_cents >= 0),
  loss_limit_week_cents    BIGINT CHECK (loss_limit_week_cents >= 0),
  self_excluded_until      TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- Grand livre en partie double
-- ════════════════════════════════════════════════════════════════════════════
-- Un compte = une devise, inscrite dans son nom ET dans sa colonne.
CREATE TABLE ledger_accounts (
  account       TEXT NOT NULL PRIMARY KEY,
  currency      currency NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account, currency),
  CONSTRAINT account_currency_suffix CHECK (account LIKE '%:' || currency::text),
  -- Un joueur ne peut JAMAIS être à découvert. Vérifié à chaque écriture (non différé).
  CONSTRAINT user_balance_non_negative CHECK (account NOT LIKE 'user:%' OR balance_cents >= 0)
);

CREATE TABLE ledger_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,   -- lock:<gameId>, settle:<gameId>, tlock:<tid>:<uid>:<n>…
  currency        currency NOT NULL,
  postings_hash   CHAR(64) NOT NULL,      -- détecte une clé réutilisée avec un contenu différent
  meta            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, currency)
);

CREATE TABLE ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL,
  account        TEXT NOT NULL,
  currency       currency NOT NULL,
  amount_cents   BIGINT NOT NULL CHECK (amount_cents <> 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ADR-6 : une écriture a la devise de sa transaction ET celle de son compte.
  -- Impossible d'écrire des EUR sur un compte PLAY, ou de mélanger deux devises dans un lot.
  FOREIGN KEY (transaction_id, currency) REFERENCES ledger_transactions (id, currency),
  FOREIGN KEY (account, currency)        REFERENCES ledger_accounts (account, currency)
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, currency);
CREATE INDEX ledger_entries_tx_idx      ON ledger_entries (transaction_id);

-- Solde maintenu dans la même transaction que l'écriture. SECURITY DEFINER : le rôle
-- applicatif n'a pas besoin du droit UPDATE sur ledger_accounts.
--
-- Comptes `house:*` (rake, faucet…) : PAS de solde en cache. Chaque règlement crédite
-- house:rake ; maintenir sa ligne ferait de ce compte un point de contention unique
-- qui sérialise TOUS les règlements (conflits SERIALIZABLE en cascade sous charge).
-- Leur solde se lit par SUM(ledger_entries). Ils n'ont aucune contrainte de solde.
CREATE OR REPLACE FUNCTION ledger_apply_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.account LIKE 'house:%' THEN
    RETURN NEW;
  END IF;
  UPDATE ledger_accounts
     SET balance_cents = balance_cents + NEW.amount_cents, updated_at = now()
   WHERE account = NEW.account AND currency = NEW.currency;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();

-- Chaque transaction comptable est équilibrée (Σ = 0), vérifié au COMMIT.
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total BIGINT;
BEGIN
  SELECT SUM(amount_cents) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % unbalanced (sum=%)', NEW.transaction_id, total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_transaction_balanced';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_transaction_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

CREATE TRIGGER ledger_entries_immutable      BEFORE UPDATE OR DELETE ON ledger_entries      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_accounts_no_delete     BEFORE DELETE ON ledger_accounts               FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rapprochement : comptes dont le cache diverge des écritures (doit être vide).
CREATE VIEW ledger_reconciliation AS
  SELECT a.account, a.currency, a.balance_cents, COALESCE(SUM(e.amount_cents), 0)::BIGINT AS entries_sum
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account = a.account AND e.currency = a.currency
   WHERE a.account NOT LIKE 'house:%'
   GROUP BY a.account, a.currency, a.balance_cents
  HAVING a.balance_cents <> COALESCE(SUM(e.amount_cents), 0);

-- ════════════════════════════════════════════════════════════════════════════
-- Tournois
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE tournaments (
  id                   UUID PRIMARY KEY,
  format               TEXT NOT NULL CHECK (format IN ('sit_and_go', 'swiss', 'arena')),
  size                 INT  NOT NULL CHECK (size IN (4, 6, 8)),
  time_control         TEXT NOT NULL,
  currency             currency NOT NULL,
  buy_in_cents         BIGINT NOT NULL CHECK (buy_in_cents >= 0),
  sponsor_added_cents  BIGINT NOT NULL DEFAULT 0 CHECK (sponsor_added_cents >= 0),
  rake_bps             INT NOT NULL CHECK (rake_bps BETWEEN 0 AND 10000),
  payout_structure_bps INT[] NOT NULL,
  host_user_id         TEXT REFERENCES users(id),
  status               TEXT NOT NULL CHECK (status IN ('registering', 'running', 'finished', 'cancelled')),
  cancel_reason        TEXT,
  ranking              TEXT[],
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ
);
CREATE INDEX tournaments_status_idx ON tournaments (status);

CREATE TABLE tournament_entries (
  tournament_id    UUID NOT NULL REFERENCES tournaments(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  rating           INT NOT NULL,
  seed             INT,
  status           TEXT NOT NULL CHECK (status IN ('registered', 'unregistered', 'playing', 'eliminated', 'winner', 'refunded')),
  eliminated_round INT,
  final_rank       INT,
  payout_cents     BIGINT NOT NULL DEFAULT 0,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE tournament_matches (
  tournament_id UUID NOT NULL REFERENCES tournaments(id),
  round         INT  NOT NULL,
  slot          INT  NOT NULL,
  player1       TEXT REFERENCES users(id),
  player2       TEXT REFERENCES users(id),           -- NULL = exempt (bye)
  winner        TEXT REFERENCES users(id),
  games         JSONB NOT NULL DEFAULT '[]',         -- [{gameId, white, black, result, kind}]
  status        TEXT NOT NULL CHECK (status IN ('pending', 'playing', 'done')),
  PRIMARY KEY (tournament_id, round, slot)
);

-- ════════════════════════════════════════════════════════════════════════════
-- Parties & classement
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE games (
  id                  UUID PRIMARY KEY,
  tournament_id       UUID REFERENCES tournaments(id),
  white_id            TEXT NOT NULL REFERENCES users(id),
  black_id            TEXT NOT NULL REFERENCES users(id),
  time_control        TEXT NOT NULL,
  currency            currency NOT NULL,
  buy_in_cents        BIGINT NOT NULL DEFAULT 0,
  rated               BOOLEAN NOT NULL,
  result              TEXT NOT NULL CHECK (result IN ('1-0', '0-1', '1/2-1/2')),
  termination         TEXT NOT NULL,
  aborted_by          CHAR(1) CHECK (aborted_by IN ('w', 'b')),
  pgn                 TEXT NOT NULL,
  move_times_ms       INT[] NOT NULL DEFAULT '{}',
  white_rating_before INT, white_rating_after INT,
  black_rating_before INT, black_rating_after INT,
  ended_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (white_id <> black_id)
);
CREATE INDEX games_white_idx ON games (white_id, ended_at DESC);
CREATE INDEX games_black_idx ON games (black_id, ended_at DESC);
CREATE TRIGGER games_immutable BEFORE UPDATE OR DELETE ON games FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ratings (
  user_id      TEXT NOT NULL REFERENCES users(id),
  time_control TEXT NOT NULL,
  rating       INT  NOT NULL DEFAULT 1500 CHECK (rating BETWEEN 100 AND 4000),
  games        INT  NOT NULL DEFAULT 0 CHECK (games >= 0),
  peak         INT  NOT NULL DEFAULT 1500,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, time_control)
);

CREATE TABLE rating_history (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  time_control  TEXT NOT NULL,
  game_id       UUID NOT NULL REFERENCES games(id),
  rating_before INT NOT NULL,
  rating_after  INT NOT NULL,
  k_factor      INT NOT NULL,
  score         NUMERIC(2,1) NOT NULL CHECK (score IN (0, 0.5, 1)),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_id)
);
CREATE TRIGGER rating_history_immutable BEFORE UPDATE OR DELETE ON rating_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE anticheat_reports (
  game_id           UUID NOT NULL REFERENCES games(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  engine            TEXT NOT NULL,
  depth             INT  NOT NULL,
  acpl              NUMERIC(6,1) NOT NULL,
  engine_match_rate NUMERIC(4,3) NOT NULL,
  analysed_moves    INT NOT NULL,
  focus_loss        INT NOT NULL,
  verdict           TEXT NOT NULL,
  score             INT  NOT NULL,
  reasons           TEXT[] NOT NULL,
  reviewed_by       TEXT REFERENCES users(id),
  review_decision   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE payment_intents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  psp          TEXT NOT NULL,
  psp_ref      TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'created',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- Journal d'audit chaîné (SHA-256)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE audit_log (
  seq       BIGINT PRIMARY KEY CHECK (seq >= 1),
  ts        TIMESTAMPTZ NOT NULL,
  type      TEXT NOT NULL,
  payload   JSONB NOT NULL,
  prev_hash CHAR(64) NOT NULL,
  hash      CHAR(64) NOT NULL UNIQUE
);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Tête de chaîne (une seule ligne). Verrouillée FOR UPDATE à chaque écriture :
-- sérialise les écrivains, y compris entre plusieurs instances du game-server.
CREATE TABLE audit_head (
  id   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  seq  BIGINT NOT NULL,
  hash CHAR(64) NOT NULL
);
INSERT INTO audit_head (id, seq, hash) VALUES (TRUE, 0, repeat('0', 64));

-- Rôle applicatif recommandé en production (TRUNCATE contourne les triggers) :
--   GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO app_rw;
--   GRANT UPDATE ON ratings, tournaments, tournament_entries, tournament_matches, audit_head, users TO app_rw;
--   GRANT INSERT (account, currency) ON ledger_accounts TO app_rw;
--   REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, ledger_transactions, audit_log, games, rating_history FROM app_rw;
