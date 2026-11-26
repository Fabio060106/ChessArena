-- Parties importées depuis un autre site (Lichess) : elles alimentent le répertoire d'ouvertures du joueur.
CREATE TABLE imported_games (
  user_id      TEXT NOT NULL REFERENCES users(id),
  source       TEXT NOT NULL,
  ext_id       TEXT NOT NULL,
  account      TEXT NOT NULL,
  played_at    TIMESTAMPTZ NOT NULL,
  color        CHAR(1) NOT NULL CHECK (color IN ('w', 'b')),
  opponent     TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'draw')),
  speed        TEXT NOT NULL,
  opening      TEXT,
  pgn          TEXT NOT NULL CHECK (octet_length(pgn) <= 20000),
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source, ext_id)
);
CREATE INDEX imported_games_user_idx ON imported_games (user_id, played_at DESC);
