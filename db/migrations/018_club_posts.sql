-- Annonces d'un club (publiées par le fondateur, affichées sur la page du club).
CREATE TABLE club_posts (
  id         BIGSERIAL PRIMARY KEY,
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  author     TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX club_posts_club_idx ON club_posts (club_id, created_at DESC);
