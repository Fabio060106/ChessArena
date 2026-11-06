-- Tournois de 2 à 128 joueurs (exempts au 1er tour quand le nombre n'est pas une puissance de 2).
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_size_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_size_check CHECK (size BETWEEN 2 AND 128);
