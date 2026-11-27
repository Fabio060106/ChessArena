-- Instantané complet d'un tournoi (classement, rondes, parties) : page publique et historique,
-- y compris après la fin du tournoi et un redémarrage du serveur.
ALTER TABLE tournaments ADD COLUMN snapshot JSONB;
CREATE INDEX IF NOT EXISTS tournament_entries_user_idx ON tournament_entries (user_id);
