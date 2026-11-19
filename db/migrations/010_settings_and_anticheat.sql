-- Réglages du joueur (apparence, son…) : retrouvés sur tous ses appareils.
CREATE TABLE user_settings (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Anti-triche : signaux calculés à la fin de chaque partie (pour revue humaine, jamais de sanction automatique).
CREATE TABLE cheat_signals (
  game_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  focus_losses  INT NOT NULL DEFAULT 0,      -- sorties de l'onglet pendant son propre temps de réflexion
  away_ms       INT NOT NULL DEFAULT 0,      -- temps total passé hors de l'onglet pendant son tour
  moves         INT NOT NULL DEFAULT 0,
  time_cv       REAL,                         -- régularité des temps de réflexion (écart-type / moyenne)
  reasons       TEXT[] NOT NULL DEFAULT '{}',
  flagged       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  verdict       TEXT,
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX cheat_signals_open ON cheat_signals (created_at DESC) WHERE flagged AND reviewed_at IS NULL;

-- Signalements de triche par les joueurs.
CREATE TABLE cheat_reports (
  id           BIGSERIAL PRIMARY KEY,
  reporter_id  TEXT NOT NULL,
  reported_id  TEXT NOT NULL,
  game_id      TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ,
  UNIQUE (reporter_id, game_id)
);
