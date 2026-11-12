-- Classement par cadence : lecture des meilleurs Elo sans parcourir toute la table.
CREATE INDEX IF NOT EXISTS ratings_tc_rating ON ratings (time_control, rating DESC) WHERE games > 0;
