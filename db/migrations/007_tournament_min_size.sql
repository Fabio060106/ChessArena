-- À 2 joueurs, ce n'est pas un tournoi : minimum 3 (tables officielles : 4, 6 ou 8).
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_size_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_size_check CHECK (size BETWEEN 3 AND 128);
