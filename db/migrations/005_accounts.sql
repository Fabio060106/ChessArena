-- Comptes joueurs : mot de passe (scrypt), drapeau affiché, consentements.
-- Les pseudos de la bêta (lignes sans mot de passe) peuvent être « réclamés » une seule fois.
ALTER TABLE users
  ADD COLUMN password_hash      TEXT,
  ADD COLUMN display_flag       TEXT CHECK (display_flag ~ '^[A-Z]{2}$'),
  ADD COLUMN terms_accepted_at  TIMESTAMPTZ,
  ADD COLUMN adult_confirmed_at TIMESTAMPTZ;

-- recherche insensible à la casse (« Fabio » et « fabio » sont le même pseudo)
CREATE INDEX users_id_lower ON users (lower(id));
