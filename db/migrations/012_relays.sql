-- Retransmissions de tournois officiels (échiquiers électroniques DGT / LiveChessCloud), ajoutées par l'organisateur.
CREATE TABLE relays (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lcc_id      TEXT NOT NULL,
  round       INT  NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
