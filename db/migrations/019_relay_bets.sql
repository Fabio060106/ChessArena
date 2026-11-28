-- Pronostics en jetons (sans valeur) sur les parties retransmises : cote figée à la mise, réglés au résultat.
CREATE TABLE relay_bets (
  id           UUID PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  market       TEXT NOT NULL,             -- « <relayId>:<ronde>:<partie> »
  relay_id     TEXT NOT NULL,
  pick         TEXT NOT NULL CHECK (pick IN ('white', 'draw', 'black')),
  stake_cents  INT  NOT NULL CHECK (stake_cents > 0),
  odds         NUMERIC(6,2) NOT NULL CHECK (odds >= 1.01),
  ply          INT  NOT NULL,             -- position au moment de la mise
  label        TEXT NOT NULL,             -- « Gukesh – Sindarov, partie 7 »
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  payout_cents INT  NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ
);
CREATE INDEX relay_bets_market_open_idx ON relay_bets (market) WHERE status = 'open';
CREATE INDEX relay_bets_user_idx ON relay_bets (user_id, created_at DESC);
