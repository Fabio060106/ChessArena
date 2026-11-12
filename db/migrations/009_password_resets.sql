-- Codes de réinitialisation de mot de passe, donnés par l'organisateur (pas de service d'e-mail).
-- Le code n'est jamais stocké en clair (haché scrypt) ; usage unique ; valable 48 h.
CREATE TABLE password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);

-- Signalements de messages du chat (modération par l'organisateur).
CREATE TABLE chat_reports (
  id           BIGSERIAL PRIMARY KEY,
  reporter_id  TEXT NOT NULL,
  reported_id  TEXT NOT NULL,
  game_id      TEXT NOT NULL,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at   TIMESTAMPTZ
);
CREATE INDEX chat_reports_open ON chat_reports (created_at DESC) WHERE handled_at IS NULL;

-- Joueurs privés de chat par l'organisateur.
ALTER TABLE users ADD COLUMN chat_muted_at TIMESTAMPTZ;
