/** Nom et adresse publique du site (à changer ici, ou par variables d'environnement, le jour du nom de domaine). */
export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME ?? "ChessAurum";
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://chess-arena-97af.vercel.app").replace(/\/+$/, "");
export const SITE_DESCRIPTION =
  "Jouez aux échecs en ligne : parties rapides (bullet, blitz, rapide), tournois entre amis, analyse de vos parties avec Stockfish 19, répertoire d'ouvertures et classement Elo.";
