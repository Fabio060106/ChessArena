-- Amis : chacun gère sa propre liste (comme « suivre » sur Lichess) ; un défi peut viser n'importe quel joueur.
CREATE TABLE friendships (
  user_id     TEXT NOT NULL REFERENCES users(id),
  friend_id   TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);
CREATE INDEX friendships_friend ON friendships (friend_id);
