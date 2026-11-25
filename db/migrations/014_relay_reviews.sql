-- Analyses pédagogiques des parties retransmises : calculées une fois par Stockfish (dans le navigateur
-- du premier spectateur), puis servies à tous.
CREATE TABLE relay_reviews (
  key         TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
