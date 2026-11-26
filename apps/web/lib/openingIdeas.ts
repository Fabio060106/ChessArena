import { setSeriousLines } from "./openingBook";

/**
 * Idées des sous-variantes les plus jouées au haut niveau, rattachées aux noms du livre d'ouvertures
 * (noms internationaux, en anglais). La clé la plus longue contenue dans le nom de la variante l'emporte.
 */
export const SUBLINE_IDEAS: Array<[string, string]> = [
  // ─── Partie espagnole ───
  ["Ruy Lopez", "Le fou b5 attaque le cavalier qui défend e5 : une pression lente mais durable sur le centre noir, l'une des ouvertures les plus profondes du jeu."],
  ["Ruy Lopez: Berlin Defense", "Les Noirs contre-attaquent e4 au lieu de chasser le fou par …a6 : la défense la plus solide de l'Espagnole, réputée pour neutraliser 1.e4 au plus haut niveau."],
  ["Ruy Lopez: Berlin Defense, Berlin Wall", "Le « mur de Berlin » : dames échangées dès le 9e coup, roi noir au centre mais paire de fous et structure compacte. Les Blancs ont une majorité de pions à l'aile roi (e5, f4, g4…) et cherchent à la faire avancer ; les Noirs visent …h5/…Ke8 et l'activité des fous. Arme de Kramnik contre Kasparov en 2000."],
  ["Ruy Lopez: Berlin Defense, Anti-Berlin Variation", "4.d3 évite le mur de Berlin : on garde les dames et une partie de manœuvres (c3, Nbd2-f1-g3, h3). C'est la façon moderne d'éviter la solidité noire et de garder du jeu."],
  ["Ruy Lopez: Berlin Defense, Rio Gambit Accepted", "4…Nxe4 5.Re1 : les Blancs récupèrent le pion e5 en jouant sur la colonne e, la partie reste ouverte et sans échange des dames immédiat."],
  ["Ruy Lopez: Open Berlin Defense", "Les Noirs prennent e4 : la porte d'entrée du mur de Berlin si les Blancs répondent 5.d4 Nd6 6.Bxc6 dxc6 7.dxe5 Nf5 8.Qxd8+."],
  ["Ruy Lopez: Morphy Defense", "3…a6 pose la question au fou tout de suite : il recule en a4 et garde la pression, mais les Noirs pourront chasser le fou plus tard par …b5."],
  ["Ruy Lopez: Exchange Variation", "Bxc6 : les Blancs donnent la paire de fous pour abîmer la structure noire (pions doublés c) ; leur majorité 4 contre 3 à l'aile roi est un atout en finale. Plan favori de Fischer."],
  ["Ruy Lopez: Closed", "L'Espagnole fermée : Re1, c3, h3 puis d4 ; les Noirs tiennent e5 et jouent sur l'aile dame. Manœuvres longues et typiques (Nbd2-f1-g3), un cours de stratégie à elle seule."],
  ["Ruy Lopez: Closed, Breyer Defense", "9…Nb8 ! le cavalier se replace en d7 pour soutenir e5 et libérer la colonne c : une défense élastique, chère à Spassky et Carlsen."],
  ["Ruy Lopez: Closed, Zaitsev System", "9…Bb7 et …Re8 : les Noirs mettent la pression sur e4 ; une variante très théorique, arme favorite de Karpov."],
  ["Ruy Lopez: Closed, Chigorin Defense", "…Na5 et …c5 : les Noirs gagnent de l'espace à l'aile dame et chassent le fou italien de la diagonale a2-g8."],
  ["Ruy Lopez: Marshall Attack", "8…d5 !? : un pion sacrifié pour une attaque durable sur le roi blanc. Si redoutée que les Blancs l'évitent souvent par 8.a4 ou 8.h3 (« anti-Marshall »)."],
  ["Ruy Lopez: Open", "5…Nxe4 : les Noirs prennent le pion central et obtiennent un jeu de pièces actif, au prix d'une structure un peu exposée (pion d5)."],
  // ─── Partie italienne ───
  ["Italian Game", "Le fou c4 vise f7 ; aujourd'hui, au plus haut niveau, on joue surtout une version lente (d3, c3, a4, Re1) où les manœuvres comptent plus que la tactique."],
  ["Italian Game: Giuoco Pianissimo", "d3 au lieu de d4 : un jeu lent et riche en manœuvres (a4, Re1, Nbd2-f1-g3), la version moderne de l'Italienne, très jouée par Carlsen et Caruana."],
  ["Italian Game: Two Knights Defense", "3…Nf6 contre-attaque e4 au lieu de couvrir f7 : la partie devient vite concrète, avec des pièges des deux côtés (Ng5, Fried Liver, Traxler)."],
  ["Italian Game: Evans Gambit", "4.b4 : un pion offert pour gagner du temps avec c3 et d4 : l'attaque romantique remise au goût du jour par Kasparov."],
  // ─── Écossaise, Petrov, 4 cavaliers ───
  ["Scotch Game", "3.d4 ouvre le centre tout de suite : jeu de pièces libre et clair, une arme pour éviter la théorie de l'Espagnole."],
  ["Petrov's Defense", "Défense symétrique et très solide : les Noirs contre-attaquent e4 ; au haut niveau, une arme pour annuler avec les Noirs (Caruana, Kramnik)."],
  ["Four Knights Game", "Développement symétrique des cavaliers : jeu classique et sain, les plans du milieu de jeu décident."],
  // ─── Sicilienne ───
  ["Sicilian Defense", "1…c5 : lutte asymétrique pour le centre ; les Noirs échangent un pion de l'aile contre le pion d4 et obtiennent la colonne c semi-ouverte."],
  ["Sicilian Defense: Najdorf Variation", "5…a6 : contrôle de b5 et préparation de …e5 ou …b5 ; la Sicilienne des champions (Fischer, Kasparov), riche et très théorique."],
  ["Sicilian Defense: Najdorf Variation, English Attack", "Be3, f3, Qd2, g4 et grand roque : les Blancs lancent leurs pions de l'aile roi ; les Noirs contre-attaquent à l'aile dame. Course à l'attaque."],
  ["Sicilian Defense: Najdorf Variation, Main Line", "6.Bg5 : la ligne la plus tranchante, avec …e6 et souvent …Qb6 (« pion empoisonné »)."],
  ["Sicilian Defense: Lasker-Pelikan Variation", "La Sveshnikov : …e5 et …b5 ; les Noirs acceptent un trou en d5 contre une grande activité de pièces. Arme de Carlsen contre Caruana en 2018."],
  ["Sicilian Defense: Taimanov Variation", "…Nc6 et …e6 : une Sicilienne souple, où les Noirs placent leurs pièces avant de choisir leur structure."],
  ["Sicilian Defense: Kan Variation", "…e6 et …a6 : une structure « hérisson » flexible, qui garde la dame et les fous libres."],
  ["Sicilian Defense: Dragon Variation", "…g6 et fou en g7 : contre l'attaque Yougoslave (Be3, f3, Qd2, grand roque), une course à l'attaque des deux côtés."],
  ["Sicilian Defense: Nyezhmetdinov-Rossolimo Attack", "3.Bb5 (Rossolimo) : les Blancs évitent la théorie du Sicilien ouvert et doublent souvent les pions noirs par Bxc6."],
  ["Sicilian Defense: Moscow Variation", "3.Bb5+ (attaque Moscou) : échange rapide des fous de cases blanches, un jeu solide sans la théorie du Najdorf."],
  ["Sicilian Defense: Alapin Variation", "2.c3 prépare d4 pour garder un centre de pions : un système simple contre la Sicilienne."],
  // ─── Française, Caro-Kann ───
  ["French Defense", "…e6 et …d5 : une chaîne de pions solide ; les Noirs attaquent ensuite la base (…c5) et la tête (…f6) de la chaîne blanche."],
  ["French Defense: Winawer Variation", "3…Bb4 : clouage du cavalier c3 ; après Bxc3 les Blancs ont la paire de fous et des pions doublés, les Noirs une structure solide. Très tranchant."],
  ["French Defense: Tarrasch Variation", "3.Nd2 évite le clouage …Bb4 ; souvent un pion isolé en d5 pour les Noirs, avec du jeu de pièces."],
  ["French Defense: Advance Variation", "3.e5 gagne de l'espace ; les Noirs attaquent tout de suite d4 par …c5, …Nc6 et …Qb6."],
  ["Caro-Kann Defense", "…c6 puis …d5 : comme la Française mais en gardant libre le fou de cases blanches ; structure très saine, finales souvent favorables aux Noirs."],
  ["Caro-Kann Defense: Advance Variation", "3.e5 : les Blancs gagnent de l'espace ; le fou noir sort en f5 avant …e6, puis …c5 attaque le centre."],
  ["Caro-Kann Defense: Classical Variation", "4…Bf5 : le fou sort avant …e6 ; après h4-h5 les Blancs gagnent de l'espace, les Noirs gardent une position très solide."],
  ["Caro-Kann Defense: Panov Attack", "c4 : les Blancs acceptent un pion isolé en d4 contre un jeu de pièces actif : une position de type Gambit dame."],
  ["Caro-Kann Defense: Exchange Variation", "exd5 cxd5 : structure symétrique, plan de minorité ; un jeu calme où le meilleur placement des pièces décide."],
  // ─── Gambit dame & co ───
  ["Queen's Gambit Declined", "…e6 maintient le pion d5 : la défense la plus classique ; les Noirs égalisent par …c5 ou …e5 au bon moment."],
  ["Queen's Gambit Declined: Exchange Variation", "cxd5 exd5 : structure de Carlsbad ; plan typique des Blancs : attaque de minorité (b4-b5) à l'aile dame."],
  ["Queen's Gambit Declined: Ragozin Defense", "…Bb4 : un mélange de Gambit dame et de Nimzo-indienne, plus actif que les lignes classiques."],
  ["Queen's Gambit Declined: Harrwitz Attack", "5.Bf4 : le fou se place hors de l'échange …Ne4 ; la ligne principale moderne du Gambit dame refusé."],
  ["Queen's Gambit Declined: Tartakower Defense", "…b6 et …Bb7 : une défense solide où le fou noir pèse sur la grande diagonale."],
  ["Queen's Gambit Accepted", "…dxc4 : les Noirs rendent le centre pour se développer librement et attaquer d4 ensuite par …c5."],
  ["Slav Defense", "…c6 soutient d5 tout en gardant libre le fou de cases blanches : une défense très solide contre 1.d4."],
  ["Semi-Slav Defense", "…c6 et …e6 : structure solide qui peut exploser dans les variantes Méran ou Botvinnik, parmi les plus tranchantes."],
  ["Catalan Opening", "Fou en g2 sur la grande diagonale : les Blancs sacrifient souvent c4 pour une pression durable sur l'aile dame noire. Arme de Kramnik et Carlsen."],
  // ─── Défenses indiennes ───
  ["Nimzo-Indian Defense", "…Bb4 cloue le cavalier c3 et empêche e4 ; les Noirs donnent souvent la paire de fous contre une meilleure structure."],
  ["Nimzo-Indian Defense: Classical Variation", "4.Qc2 : les Blancs évitent les pions doublés et gardent la paire de fous ; jeu riche et stratégique."],
  ["Nimzo-Indian Defense: Normal Variation", "4.e3 (Rubinstein) : développement solide, les Blancs acceptent parfois les pions doublés pour un centre fort."],
  ["Queen's Indian Defense", "…b6 et …Bb7 : contrôle de e4 à distance ; défense solide et stratégique."],
  ["King's Indian Defense", "Les Noirs laissent le centre aux Blancs pour le frapper ensuite par …e5 ; souvent une attaque de pions sur l'aile roi (…f5, …g5) contre l'attaque blanche à l'aile dame."],
  ["King's Indian Defense: Orthodox Variation", "La ligne classique (Nf3, Be2, O-O) : les Noirs jouent …e5 et, si d5, ferment le centre pour attaquer l'aile roi (Mar del Plata)."],
  ["King's Indian Defense: Sämisch Variation", "5.f3 : les Blancs consolident e4 et préparent Be3-Qd2, voire le grand roque et l'attaque."],
  ["Grünfeld Defense", "…d5 frappe le centre tout de suite ; après cxd5 Nxd5 e4, les Noirs attaquent le grand centre blanc avec le fou g7 et …c5."],
  ["Grünfeld Defense: Exchange Variation", "Grand centre blanc (c3, d4, e4) contre la pression du fou g7 et de …c5 : l'un des duels les plus théoriques du jeu."],
  // ─── Autres ───
  ["English Opening", "1.c4 contrôle d5 à distance ; jeu souple, souvent avec g3 et Bg2, qui peut transposer dans de nombreuses structures."],
  ["English Opening: King's English Variation", "1…e5 : une Sicilienne inversée où les Blancs ont un temps de plus."],
  ["English Opening: Symmetrical Variation", "1…c5 : symétrie et jeu de manœuvres, souvent avec un double fianchetto."],
  ["Réti Opening", "Nf3 et c4 : les Blancs attaquent le centre à distance avant de l'occuper."],
  ["London System", "Bf4, e3, c3, Nbd2 : une structure solide et facile à jouer ; plans d'attaque simples (Ne5, h4, g4)."],
  ["Dutch Defense", "…f5 contrôle e4 et prépare une attaque à l'aile roi ; variantes Stonewall (…d5, …e6) ou Leningrad (…g6)."],
];

setSeriousLines(SUBLINE_IDEAS.map(([k]) => k).filter((k) => k.includes(":")));

/** Idée de la sous-variante la plus précise connue pour ce nom (anglais, tel que dans le livre). */
export function sublineIdea(name: string | null | undefined): string | null {
  if (!name) return null;
  let best: [string, string] | null = null;
  for (const e of SUBLINE_IDEAS) if (name.startsWith(e[0]) && (!best || e[0].length > best[0].length)) best = e;
  return best?.[1] ?? null;
}
