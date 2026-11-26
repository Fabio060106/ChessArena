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
  ["e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4", "Défense berlinoise, variante ouverte"],
  ["e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+", "Défense berlinoise (variante du « mur de Berlin »)"],
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

/** Les idées d'une ouverture, en quelques phrases (de la famille la plus précise à la plus générale). */
const IDEAS: Array<[string, string]> = [
  ["Défense berlinoise (variante du « mur de Berlin »)", "Le « mur de Berlin » mène très tôt à une position sans dames où les Noirs ont deux fous et une structure solide, mais un roi resté au centre. Les Blancs ont une majorité de pions à l'aile roi et cherchent à la faire avancer ; les Noirs comptent sur leurs fous et sur la solidité de leur position. C'est l'arme qui a permis à Kramnik de battre Kasparov en 2000."],
  ["Défense berlinoise", "Avec 3…Cf6, les Noirs contre-attaquent tout de suite le pion e4 au lieu de chasser le fou. C'est une défense réputée très solide au plus haut niveau : les Noirs acceptent une position un peu passive en échange d'une grande sécurité, et les Blancs doivent faire preuve de patience pour créer des déséquilibres."],
  ["Partie espagnole", "Le fou en b5 attaque le cavalier qui défend le pion e5 : les Blancs exercent une pression durable sur le centre noir. Le plan typique est c3 puis d4 pour bâtir un centre de pions, tandis que les Noirs cherchent à desserrer l'étau (…a6, …b5) et à jouer …d5 au bon moment. C'est l'une des ouvertures les plus riches et les plus étudiées."],
  ["Partie italienne", "Le fou en c4 vise le point f7, la case la plus faible du camp noir au début de la partie. Les deux camps développent rapidement leurs pièces ; les Blancs préparent souvent c3 et d4 pour prendre le centre, ou une manœuvre lente avec d3 (le « Giuoco Pianissimo »)."],
  ["Défense des deux cavaliers", "Les Noirs contre-attaquent le pion e4 au lieu de défendre f7 : la partie devient vite tactique. Il faut connaître les pièges autour de Cg5 et de l'attaque sur f7."],
  ["Partie écossaise", "Avec d4, les Blancs ouvrent le centre dès le troisième coup. Le jeu des pièces devient très libre ; les Noirs doivent réagir vite (…Fc5 ou …Cf6) pour ne pas subir l'avance des Blancs."],
  ["Partie des quatre cavaliers", "Un développement symétrique et classique : les cavaliers sortent avant les fous. La position reste équilibrée et c'est souvent la qualité des plans de milieu de jeu qui fait la différence."],
  ["Défense russe (Petrov)", "Les Noirs répondent à l'attaque par une contre-attaque symétrique sur e4. Défense très solide qui vise l'égalité ; les Blancs doivent trouver des idées précises pour garder un petit avantage."],
  ["Défense Philidor", "Les Noirs défendent e5 avec le pion d6 : position solide mais un peu passive. Les Blancs ont plus d'espace et cherchent à en profiter avant que les Noirs ne libèrent leur jeu."],
  ["Gambit du roi", "Les Blancs sacrifient le pion f4 pour ouvrir la colonne f et attaquer le roi noir. Ouverture romantique et risquée, où l'initiative compte plus que le matériel."],
  ["Défense sicilienne, variante Najdorf", "Le coup …a6 contrôle b5 et prépare …e5 ou …b5. C'est la Sicilienne la plus jouée par les champions du monde (Fischer, Kasparov) : position déséquilibrée, attaques sur des ailes opposées et calcul précis."],
  ["Défense sicilienne, variante du Dragon", "Le fou noir en fianchetto (g7) forme une « queue de dragon » qui vise toute la grande diagonale. Les Blancs roquent souvent côté dame et lancent les pions vers le roi noir : course à l'attaque."],
  ["Défense sicilienne", "Avec …c5, les Noirs luttent pour le centre de façon asymétrique : ils échangent un pion de l'aile contre le pion central d4 des Blancs. Les positions sont déséquilibrées, avec du jeu pour les deux camps : c'est la défense la plus combative contre 1.e4."],
  ["Défense française", "Avec …e6 puis …d5, les Noirs bâtissent une chaîne de pions solide mais enferment leur fou de cases blanches. Le plan noir classique est de miner le centre blanc avec …c5 et …f6."],
  ["Défense Caro-Kann", "Comme la Française, les Noirs contestent le centre avec …d5, mais préparent d'abord …c6 pour pouvoir sortir leur fou de cases blanches. Défense très solide, aux structures de pions saines."],
  ["Défense scandinave", "Les Noirs attaquent e4 tout de suite avec …d5. La dame noire sort tôt et les Blancs gagnent du temps en la chassant, mais la position noire reste solide."],
  ["Défense Pirc", "Les Noirs laissent les Blancs occuper le centre avec leurs pions pour l'attaquer ensuite avec leurs pièces (fou en g7). Défense « hypermoderne »."],
  ["Défense Alekhine", "Le cavalier noir provoque l'avance des pions blancs pour qu'ils deviennent des cibles. Ouverture provocante et peu fréquente au plus haut niveau."],
  ["Gambit dame accepté", "Les Noirs prennent le pion c4 sans chercher à le garder : ils l'utilisent pour se développer librement, tandis que les Blancs récupèrent le pion et occupent le centre."],
  ["Gambit dame refusé", "Les Noirs gardent un pion solide en d5 avec …e6. Ouverture classique et sûre ; les Blancs ont un peu plus d'espace et cherchent l'attaque de minorité ou le jeu au centre."],
  ["Défense semi-slave", "Les Noirs combinent …c6 et …e6 : une structure solide qui peut mener à des positions très tranchantes (variantes Méran, Botvinnik)."],
  ["Défense slave", "Le pion c6 soutient d5 tout en laissant sortir le fou de cases blanches. Défense solide et souple, très jouée au plus haut niveau."],
  ["Gambit dame", "Les Blancs offrent le pion c4 pour détourner le pion d5 du centre. En réalité le pion n'est pas vraiment perdu : c'est surtout une lutte pour le contrôle du centre."],
  ["Système de Londres", "Les Blancs installent leur fou en f4 et une structure de pions solide (d4, e3, c3). Un système facile à jouer, qui mise sur une position saine plutôt que sur la théorie."],
  ["Ouverture catalane", "Le fou blanc en fianchetto (g2) vise l'aile dame noire à travers la grande diagonale. Les Blancs sacrifient parfois le pion c4 pour une pression durable."],
  ["Défense nimzo-indienne", "Le fou en b4 cloue le cavalier c3 et empêche e4. Les Noirs acceptent souvent de donner la paire de fous pour abîmer la structure de pions blanche."],
  ["Défense ouest-indienne", "Le fou en b7 contrôle la case e4 à distance. Défense solide et stratégique."],
  ["Défense est-indienne", "Les Noirs laissent les Blancs bâtir un grand centre pour le contre-attaquer ensuite, souvent par …e5 et une attaque de pions sur l'aile roi. Défense dynamique, chère à Kasparov et Fischer."],
  ["Défense Grünfeld", "Les Noirs laissent les Blancs prendre le centre avec leurs pions puis l'attaquent avec le fou g7 et …c5. Défense très concrète, très théorique."],
  ["Gambit Benko", "Les Noirs sacrifient un pion de l'aile dame pour ouvrir les colonnes a et b et exercer une pression durable."],
  ["Défense Benoni moderne", "Structure déséquilibrée : majorité de pions noire à l'aile dame contre majorité blanche au centre. Jeu dynamique des deux côtés."],
  ["Défense hollandaise", "Avec …f5, les Noirs contrôlent la case e4 et préparent une attaque à l'aile roi, au prix d'un roi un peu plus exposé."],
  ["Ouverture anglaise", "Les Blancs contrôlent la case d5 à distance avec c4. Ouverture souple, qui peut rejoindre de nombreuses structures."],
  ["Ouverture Réti", "Les Blancs se développent d'abord et attaquent le centre à distance (approche hypermoderne)."],
  ["Partie ouverte", "Les deux camps poussent leur pion roi de deux cases : le centre est disputé et les pièces sortent vite. Les principes de base comptent : développer, roquer, contrôler le centre."],
  ["Ouverture du pion roi", "1.e4 libère la dame et le fou de cases blanches et occupe le centre. C'est le premier coup le plus populaire de l'histoire."],
  ["Ouverture du pion dame", "1.d4 occupe le centre avec un pion déjà défendu par la dame. Les parties sont en général plus stratégiques qu'après 1.e4."],
];

export function openingIdea(name: string | null): string | null {
  if (!name) return null;
  return IDEAS.find(([k]) => name === k)?.[1] ?? IDEAS.find(([k]) => name.startsWith(k))?.[1] ?? null;
}
