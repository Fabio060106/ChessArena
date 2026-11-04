-- Répertoire d'ouvertures et exercices d'un joueur (document JSON versionné côté client).
-- Données d'entraînement uniquement : aucun lien avec les soldes ni les parties à mise.
CREATE TABLE user_repertoire (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (octet_length(data::text) <= 1048576)
);
