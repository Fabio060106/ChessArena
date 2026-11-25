-- Source d'une retransmission : échiquiers DGT (LiveChessCloud) ou Lichess Broadcast (secours).
ALTER TABLE relays ADD COLUMN source TEXT NOT NULL DEFAULT 'lcc';
