/**
 * Ouvertures courantes (noms français), reconnues par la suite exacte des premiers coups.
 * La plus longue correspondance l'emporte : « Partie espagnole » puis « Défense berlinoise »…
 */
const OPENINGS: Array<[string, string]> = [
  ["e4", "Ouverture du pion roi"],
  ["e4 e5", "Partie ouverte"],
  ["e4 e5 Nf3 Nc6", "Partie ouverte"],
  ["e4 e5 Nf3 Nc6 Bb5", "Partie espagnole"],
  ["e4 e5 Nf3 Nc6 Bb5 a6", "Partie espagnole, variante Morphy"],
  ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", "Partie espagnole fermée"],
  ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4", "Partie espagnole ouverte"],
  ["e4 e5 Nf3 Nc6 Bb5 a6 Bxc6", "Partie espagnole, variante d'échange"],
  ["e4 e5 Nf3 Nc6 Bb5 Nf6", "Défense berlinoise"],
  ["e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4", "Défense berlinoise (variante du « mur de Berlin »)"],
  ["e4 e5 Nf3 Nc6 Bb5 Nf6 d3", "Défense berlinoise, système anti-berlinois d3"],
  ["e4 e5 Nf3 Nc6 Bc4", "Partie italienne"],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5", "Partie italienne, Giuoco Piano"],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3", "Partie italienne, Giuoco Pianissimo / c3"],
  ["e4 e5 Nf3 Nc6 Bc4 Nf6", "Défense des deux cavaliers"],
  ["e4 e5 Nf3 Nc6 d4", "Partie écossaise"],
  ["e4 e5 Nf3 Nc6 Nc3 Nf6", "Partie des quatre cavaliers"],
  ["e4 e5 Nf3 Nf6", "Défense russe (Petrov)"],
  ["e4 e5 Nf3 d6", "Défense Philidor"],
  ["e4 e5 f4", "Gambit du roi"],
  ["e4 c5", "Défense sicilienne"],
  ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "Défense sicilienne, variante Najdorf"],
  ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6", "Défense sicilienne, variante du Dragon"],
  ["e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5", "Défense sicilienne, variante Svechnikov"],
  ["e4 c5 Nf3 e6", "Défense sicilienne, variante Paulsen / Taimanov"],
  ["e4 c5 Nf3 Nc6 Bb5", "Défense sicilienne, attaque Rossolimo"],
  ["e4 c5 Nf3 d6 Bb5+", "Défense sicilienne, attaque Moscou"],
  ["e4 c5 c3", "Défense sicilienne, variante Alapine"],
  ["e4 e6", "Défense française"],
  ["e4 e6 d4 d5 Nc3 Bb4", "Défense française, variante Winawer"],
  ["e4 e6 d4 d5 Nd2", "Défense française, variante Tarrasch"],
  ["e4 e6 d4 d5 e5", "Défense française, variante d'avance"],
  ["e4 c6", "Défense Caro-Kann"],
  ["e4 c6 d4 d5 e5", "Défense Caro-Kann, variante d'avance"],
  ["e4 d5", "Défense scandinave"],
  ["e4 d6", "Défense Pirc"],
  ["e4 Nf6", "Défense Alekhine"],
  ["d4", "Ouverture du pion dame"],
  ["d4 d5 c4", "Gambit dame"],
  ["d4 d5 c4 dxc4", "Gambit dame accepté"],
  ["d4 d5 c4 e6", "Gambit dame refusé"],
  ["d4 d5 c4 c6", "Défense slave"],
  ["d4 d5 c4 c6 Nf3 Nf6 Nc3 e6", "Défense semi-slave"],
  ["d4 d5 Bf4", "Système de Londres"],
  ["d4 Nf6 Bf4", "Système de Londres"],
  ["d4 Nf6 c4 e6 g3", "Ouverture catalane"],
  ["d4 Nf6 c4 e6 Nf3 d5 g3", "Ouverture catalane"],
  ["d4 Nf6 c4 e6 Nc3 Bb4", "Défense nimzo-indienne"],
  ["d4 Nf6 c4 e6 Nf3 b6", "Défense ouest-indienne"],
  ["d4 Nf6 c4 g6 Nc3 Bg7 e4", "Défense est-indienne"],
  ["d4 Nf6 c4 g6 Nc3 d5", "Défense Grünfeld"],
  ["d4 Nf6 c4 c5 d5 b5", "Gambit Benko"],
  ["d4 Nf6 c4 c5 d5 e6", "Défense Benoni moderne"],
  ["d4 f5", "Défense hollandaise"],
  ["c4", "Ouverture anglaise"],
  ["c4 e5", "Ouverture anglaise, sicilienne inversée"],
  ["Nf3", "Ouverture Réti"],
  ["Nf3 d5 c4", "Ouverture Réti"],
];

const TABLE = OPENINGS.map(([moves, name]) => ({ moves: moves.split(" "), name }));

/** Nom de l'ouverture jouée, et nombre de demi-coups « théoriques » reconnus (0 si inconnue). */
export function openingOf(sans: readonly string[]): { name: string | null; plies: number } {
  let best: { name: string; plies: number } | null = null;
  for (const o of TABLE) {
    if (o.moves.length > sans.length) continue;
    if (o.moves.every((m, i) => sans[i]?.replace(/[+#]$/, "") === m.replace(/[+#]$/, "")) && (!best || o.moves.length > best.plies)) {
      best = { name: o.name, plies: o.moves.length };
    }
  }
  return best ?? { name: null, plies: 0 };
}
