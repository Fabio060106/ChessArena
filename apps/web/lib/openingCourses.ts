/**
 * La matière d'étude de chaque ouverture : structures de pions, plans des deux camps, erreurs typiques,
 * pièges à connaître (vérifiés : légalité dans les tests, résultat par Stockfish dans scripts/check-repertoires.mjs).
 */
export interface Trap {
  name: string;
  /** coups depuis le début (SAN) jusqu'à la position gagnante */
  moves: string;
  /** le camp qui profite du piège */
  winner: "w" | "b";
  text: string;
}
export interface Structure { title: string; moves: string; text: string }
export interface Course {
  structures: Structure[];
  plans: { me: string[]; them: string[] };
  mistakes: string[];
  traps: Trap[];
}

// ─── Pièges communs ───
const T: Record<string, Trap> = {
  blackburne: { name: "Le piège Blackburne-Shilling (3…Nd4)", moves: "e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5 Nxf7 Qxg2 Rf1 Qxe4+ Be2 Nf3#", winner: "b",
    text: "3…Nd4 laisse e5 en prise… mais 4.Nxe5? Qg5! attaque e5 et g2 : si 5.Nxf7, la dame entre en g2 et le cavalier mate en f3. Avec les Blancs, répondre 4.Nxd4 ou 4.O-O." },
  noahsArk: { name: "Le piège de l'Arche de Noé", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 d6 d4 b5 Bb3 Nxd4 Nxd4 exd4 Qxd4 c5 Qd5 Be6 Qc6+ Bd7 Qd5 c4", winner: "b",
    text: "Dans l'Espagnole, le fou b3 peut être enfermé par …c5-c4. Avec les Blancs : ne pas reprendre 8.Qxd4 ; avec les Noirs : surveiller l'occasion." },
  mortimer: { name: "Le piège Mortimer (Berlinoise, 4.d3 Ne7)", moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Ne7 Nxe5 c6 Ba4 Qa5+ Nc3 Qxe5", winner: "b",
    text: "4…Ne7 semble laisser e5 en prise ; après 5.Nxe5? c6 6.Ba4? Qa5+ l'échec double gagne le cavalier." },
  frenchQueen: { name: "La dame perdue de la Française d'avance", moves: "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 Bd3 cxd4 cxd4 Nxd4 Nxd4 Qxd4 Bb5+", winner: "w",
    text: "Le pion d4 semble gratuit, mais après …Nxd4 Nxd4 Qxd4, Bb5+ découvre l'attaque de la dame d1 sur d4 : la dame noire tombe. Avec les Noirs, jouer 7…Bd7." },
  caroSmother: { name: "Le mat étouffé de la Caro-Kann (5.Qe2)", moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Qe2 Ngf6 Nd6#", winner: "w",
    text: "Après 5.Qe2, le coup naturel 5…Ngf6?? permet Nd6 mat : le pion e7 est cloué par la dame. Avec les Noirs, jouer 4…Bf5 (notre répertoire) évite tout cela." },
  elephant: { name: "Le piège de l'éléphant (Gambit dame refusé)", moves: "d4 d5 c4 e6 Nc3 Nf6 Bg5 Nbd7 cxd5 exd5 Nxd5 Nxd5 Bxd8 Bb4+ Qd2 Bxd2+ Kxd2 Kxd8", winner: "b",
    text: "6.Nxd5? semble gagner un pion car le cavalier f6 est cloué… mais 6…Nxd5! 7.Bxd8 Bb4+ récupère la dame : les Noirs gagnent une pièce." },
  qgaB5: { name: "Garder le pion du Gambit dame accepté ? (…b5?)", moves: "d4 d5 c4 dxc4 e3 b5 a4 c6 axb5 cxb5 Qf3", winner: "w",
    text: "Défendre c4 par …b5 ne marche pas : a4 puis Qf3 attaque la tour a8 et le pion b5 tombe avec gain de matériel." },
  kgDeclined: { name: "Gambit du roi refusé : 3.fxe5?? Qh4+", moves: "e4 e5 f4 Bc5 fxe5 Qh4+ g3 Qxe4+ Qe2 Qxh1", winner: "b",
    text: "Contre 2…Bc5, prendre tout de suite en e5 ouvre la diagonale du roi blanc : …Qh4+ puis …Qxe4+ et la tour h1 tombe. Jouer d'abord Nf3." },
  dutchMate: { name: "Le mat de la Hollandaise (…Rh6??)", moves: "d4 f5 Bg5 h6 Bh4 g5 Bg3 f4 e3 h5 Bd3 Rh6 Qxh5+ Rxh5 Bg6#", winner: "w",
    text: "Les poussées …g5, …h5 affaiblissent la diagonale e8-h5 : après …Rh6??, Qxh5+ et Bg6 mat. Avec les Noirs, ne pas affaiblir le roi sans nécessité." },
  /** (pas un piège gagnant : la dame noire peut répéter les coups ; gardé comme exemple dans les lignes du répertoire) */
  londonB2: { name: "Le pion b2 empoisonné du Londres", moves: "d4 Nf6 Bf4 c5 e3 Qb6 Nc3 Qxb2 Nb5 Na6 Rb1 Qxa2 Ra1 Qb2 Rb1", winner: "w",
    text: "Prendre en b2 expose la dame : Nb5 menace Nc7+ et Rb1 la chasse ; au mieux les Noirs répètent les coups, au pire elle est piégée." },
};

export const COURSES: Record<string, Course> = {
  italian: {
    structures: [
      { title: "Le centre c3-d3 contre e5-d6", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O", text: "Le centre est équilibré et fermé à moitié : personne n'a de rupture immédiate. La partie se joue sur les manœuvres (cavalier b1-d2-f1-g3) et sur le moment de la rupture d3-d4." },
      { title: "Après d4 : le centre s'ouvre", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5", text: "Si les Blancs jouent d4 tôt, ils obtiennent un centre de pions, mais les Noirs frappent avec …d5 : savoir quand la rupture est prête est la clé." },
    ],
    plans: {
      me: ["a4 contre …b5 (le fou c4 reste sur la diagonale)", "Re1, h3, Nbd2-f1-g3 puis Nf5 ou Nh4-f5", "Rupture d3-d4 quand toutes les pièces sont prêtes", "Bg5 ou Be3 pour échanger le fou c5 s'il est gênant"],
      them: ["…a6 et …Ba7 pour garder le fou", "…h6 contre Bg5, …Be6 pour échanger le fou c4", "…d5 au bon moment pour libérer le jeu"],
    },
    mistakes: ["Jouer d4 avant d'avoir roqué : le roi blanc reste exposé au centre.", "Bg5 trop tôt : …h6, …g5 et le fou se retrouve hors-jeu.", "Oublier a4 : …b5 et …Na5 chassent le fou italien."],
    traps: [T.blackburne],
  },
  evans: {
    structures: [{ title: "Le grand centre après c3-d4", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O", text: "Un pion de moins, mais le centre et l'avance de développement : chaque temps compte, il faut ouvrir les lignes avant que les Noirs ne roquent." }],
    plans: { me: ["c3 et d4 avec gain de temps sur le fou noir", "Qb3 et la pression sur f7", "Ba3 pour empêcher le roque noir"], them: ["Rendre le pion au bon moment (…d5 ou …d6)", "Échanger les pièces actives blanches"] },
    mistakes: ["Récupérer le pion trop vite : l'initiative disparaît.", "Laisser les Noirs roquer tranquillement."],
    traps: [T.blackburne],
  },
  scotch: {
    structures: [{ title: "Les pions doublés c6-c7 (variante Mieses)", moves: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4", text: "Le pion e5 gêne le développement noir ; en échange les Noirs ont la colonne b et le fou a6 contre c4." }],
    plans: { me: ["e5 puis c4 pour chasser le cavalier d5", "Fianchetto g3/Bg2 et pression sur la grande diagonale", "Pions de l'aile dame contre les pions doublés"], them: ["…Ba6 contre c4", "…g6 et …Bg7 contre e5", "…d6 pour éliminer e5"] },
    mistakes: ["Laisser le cavalier d4 sans soutien : …Bc5 et …Qf6 le visent.", "Oublier le roque : le roi au centre souffre quand le jeu s'ouvre."],
    traps: [],
  },
  ruy: {
    structures: [
      { title: "L'Espagnole fermée : e4-d4 contre e5-d6", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3", text: "Le centre tient des deux côtés : les Blancs manœuvrent (Nbd2-f1-g3) et préparent d4 ; les Noirs jouent sur l'aile dame (…c5, …Nc6-a5)." },
      { title: "Le mur de Berlin", moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8", text: "Finale sans dames : majorité blanche à l'aile roi (e5, f4-f5) contre la paire de fous noire. C'est pour éviter cette position que notre répertoire joue 4.d3." },
    ],
    plans: { me: ["Pression lente sur e5 : c3, d4, Nbd2-f1-g3", "a4 contre l'aile dame noire", "Fou b3-c2 qui vise le roque noir"], them: ["…b5, …Na5, …c5 : espace à l'aile dame", "…Re8, …Bf8, …g6, …Bg7 : défense de l'aile roi", "…d5 (Marshall) pour un gambit d'attaque"] },
    mistakes: ["8.Qxd4 contre la Steinitz différée : le fou b3 se fait enfermer (piège de l'Arche de Noé).", "Jouer d4 sans h3 : …Bg4 cloue le cavalier f3."],
    traps: [T.noahsArk, T.mortimer],
  },
  kgambit: {
    structures: [{ title: "La colonne f ouverte", moves: "e4 e5 f4 exf4 Nf3 d6 d4 g5 h4 g4 Ng1", text: "Les Blancs ont le centre et la colonne f ; les Noirs un pion de plus et une chaîne g5-f4 à attaquer par h4." }],
    plans: { me: ["Bc4, O-O et la tour f1 contre f7", "h4 pour casser la chaîne …g5", "Récupérer f4 avec les pièces (Ne2, Bxf4)"], them: ["…d5 pour rendre le pion et se développer", "…g5 pour garder le pion"] },
    mistakes: ["Contre 2…Bc5, prendre en e5 tout de suite.", "Oublier que le roi blanc est lui aussi exposé sur la diagonale e1-h4."],
    traps: [T.kgDeclined],
  },
  "e4-complement": {
    structures: [{ title: "La chaîne d4-e5 (variantes d'avance)", moves: "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3", text: "L'espace blanc à l'aile roi contre la pression noire sur d4 : défendre d4 (c3, Nf3, Be2) et attaquer sur l'aile roi." }],
    plans: { me: ["Soutenir d4 et e5", "Jouer sur l'aile où l'on a de l'espace"], them: ["Attaquer la base de la chaîne (…c5)", "Saper la tête (…f6)"] },
    mistakes: ["Laisser tomber d4 : toute la chaîne s'écroule."],
    traps: [T.frenchQueen, T.caroSmother],
  },
  london: {
    structures: [{ title: "La structure Londres (d4-e3-c3)", moves: "d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3", text: "Une structure en pyramide très solide ; le fou f4 est sorti avant e3. Les plans : Ne5 et f4, ou e4 pour ouvrir le centre." }],
    plans: { me: ["Bf4 AVANT e3", "Ne5, f4, puis Rf3-h3 contre le roque", "Bg3 contre …Bd6 pour garder le fou"], them: ["…c5 et …Qb6 contre b2", "…Bd6 pour échanger le fou f4", "…e5 pour se libérer"] },
    mistakes: ["e3 avant Bf4 : le fou reste enfermé.", "Oublier b2 face à …Qb6."],
    traps: [],
  },
  qgambit: {
    structures: [{ title: "La structure de Carlsbad", moves: "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 Be7 e3 O-O Bd3", text: "Pions c6-d5 contre c3-d4 (après …c6) : attaque de minorité blanche b4-b5 pour créer une faiblesse en c6 ; les Noirs attaquent à l'aile roi." }],
    plans: { me: ["Attaque de minorité : Rb1, b4-b5", "Qc2 et Bd3 contre h7", "e4 si les Noirs jouent passivement"], them: ["…Ne4 et …f5 (structure Stonewall)", "…Nf8-g6 et l'attaque à l'aile roi"] },
    mistakes: ["6.Nxd5? dans le Gambit dame refusé : le piège de l'éléphant.", "Croire que …dxc4 ne se récupère pas : e3 et Bxc4 suffisent."],
    traps: [T.elephant, T.qgaB5],
  },
  english: {
    structures: [{ title: "La Sicilienne inversée", moves: "c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2 Nb6 Nf3 Nc6 O-O Be7", text: "Les Blancs ont une Dragon avec un temps de plus : la grande diagonale et l'aile dame (a3, b4) sont leurs armes." }],
    plans: { me: ["Fou g2 contre la grande diagonale", "a3, b4-b5 et Rb1", "Contrôle de d5"], them: ["…d5 et un centre de pions", "…f5 et l'attaque à l'aile roi"] },
    mistakes: ["Oublier le contrôle de d5 : les Noirs s'installent au centre."],
    traps: [],
  },
  "d4-complement": {
    structures: [{ title: "Le fianchetto contre les défenses indiennes", moves: "d4 Nf6 c4 g6 Nc3 Bg7 Nf3 O-O g3 d6 Bg2", text: "Le fou g2 neutralise le fou g7 noir et rend les attaques noires à l'aile roi moins efficaces." }],
    plans: { me: ["g3/Bg2 contre les fianchettos noirs", "e4 pour gagner de l'espace"], them: ["…e5 ou …c5 pour frapper le centre"] },
    mistakes: ["Laisser les Noirs jouer …e5-e4 sans réaction."],
    traps: [],
  },
  caro: {
    structures: [
      { title: "La structure Caro-Kann classique", moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7", text: "Pions c6-e6 très solides, pas de faiblesse ; les Blancs ont un peu d'espace (d4, h5) mais pas de cible claire." },
      { title: "La Caro-Kann d'avance", moves: "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5", text: "Le fou est sorti avant …e6 ; …c5 attaque la chaîne blanche par la base, …Nc6 et …Qb6 visent d4." },
    ],
    plans: { me: ["Fou c8 dehors avant …e6", "…c5 contre la chaîne d4-e5", "Grand roque et finales favorables"], them: ["Espace avec h4-h5 et e5", "Attaque à l'aile roi si les Noirs roquent court"] },
    mistakes: ["…e6 avant de sortir le fou : il reste enfermé.", "5…Ngf6?? après 4…Nd7 5.Qe2 : mat étouffé en d6."],
    traps: [T.caroSmother],
  },
  french: {
    structures: [{ title: "La chaîne française e6-d5 contre d4-e5", moves: "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6", text: "La chaîne blanche se combat à la base (…c5) et à la tête (…f6) ; le fou c8 est souvent la pièce difficile." }],
    plans: { me: ["…c5, …Nc6, …Qb6 contre d4", "…f6 contre e5", "…Bd7-b5 ou …b6-…Ba6 pour activer le fou c8"], them: ["Attaque à l'aile roi (Bd3, Qg4, h4)", "Défense de d4 (c3, Nf3, Be2)"] },
    mistakes: ["Prendre d4 avec le cavalier quand Bb5+ découvre la dame (piège de la Française d'avance).", "Roquer court quand les Blancs ont Qg4 et Bd3 prêts."],
    traps: [T.frenchQueen],
  },
  e5: {
    structures: [{ title: "Le jeu ouvert symétrique", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6", text: "Les mêmes principes que les Blancs : développement, roque, contrôle du centre. Copier intelligemment les plans blancs (…a6, …Ba7, …h6)." }],
    plans: { me: ["La Berlinoise contre l'Espagnole", "…a6, …Ba7, …h6 contre l'Italienne lente", "…d5 au bon moment"], them: ["d4 pour ouvrir le centre", "Pression sur e5 et f7"] },
    mistakes: ["Négliger f7 face à Bc4 et Ng5.", "Jouer …Nd4 sans le préparer… sauf pour tendre le piège Blackburne."],
    traps: [T.blackburne, T.mortimer, T.noahsArk],
  },
  sicilian: {
    structures: [{ title: "La structure Najdorf (…d6-…e5)", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7", text: "Le pion d6 est arriéré mais protégé ; la case d5 est le point clé : la contrôler par …Be6 et …Nf6, sinon …d5 libère tout." }],
    plans: { me: ["…a6, …b5-b4 et la colonne c", "…Rxc3 (sacrifice de qualité) contre le roque blanc", "…d5 ou …e5 pour frapper le centre"], them: ["Grand roque et attaque des pions (g4, h4)", "Nd5 et contrôle de d5"] },
    mistakes: ["Laisser les Blancs s'installer en d5.", "Perdre un temps dans les positions de roques opposés : l'attaque blanche va vite."],
    traps: [],
  },
  dragon: {
    structures: [{ title: "Le Dragon contre l'attaque yougoslave", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6 O-O-O", text: "Roques opposés : les Blancs ouvrent la colonne h (h4-h5), les Noirs la colonne c (…Rc8, …Ne5-c4, …Rxc3)." }],
    plans: { me: ["9…d5 ou …Rc8, …Ne5-c4", "Sacrifice de qualité …Rxc3", "Garder le fou g7 à tout prix"], them: ["Bh6 pour échanger le fou g7", "h4-h5 et attaque sur la colonne h"] },
    mistakes: ["Laisser Bh6 échanger le fou du Dragon sans réaction.", "Jouer lentement : chaque temps compte dans la course."],
    traps: [],
  },
  scandi: {
    structures: [{ title: "La structure Caro-Kann sans pion d", moves: "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 Bf5 Bc4 e6", text: "Pions c6-e6 solides et fou sorti en f5 : une position saine où les Blancs ont juste un peu d'espace." }],
    plans: { me: ["Dame en a5 ou d6, …c6 pour lui garder une retraite", "Fou c8 en f5 ou g4", "Grand roque possible"], them: ["Gain de temps sur la dame (Nc3, Bd2, Nd5)", "Attaque rapide avec Bc4 et Qe2"] },
    mistakes: ["Laisser la dame sans retraite : Nd5, Bb5+ ou b4 la chassent avec gain.", "Oublier …c6 : Nb5 devient gênant."],
    traps: [],
  },
  qgd: {
    structures: [{ title: "Le Gambit dame refusé orthodoxe", moves: "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6", text: "Le pion d5 est le pilier ; les Noirs égalisent par …b6/…Bb7 (Tartakower) ou …c5." }],
    plans: { me: ["Tenir d5", "…c5 ou …e5 pour égaliser", "…Ne4 pour échanger les pièces"], them: ["Attaque de minorité (b4-b5)", "Pression sur le pion d5"] },
    mistakes: ["Lâcher d5 sans compensation.", "Oublier le clouage Bg5 sur f6."],
    traps: [T.elephant],
  },
  slav: {
    structures: [{ title: "La structure slave", moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4", text: "Pions c6-e6, fou f5 actif : la défense la plus saine contre 1.d4." }],
    plans: { me: ["Fou c8 en f5 avant …e6", "…dxc4 quand les Blancs ne peuvent pas le récupérer facilement", "…Bb4 et …O-O"], them: ["e4 pour prendre le centre", "Nh4 contre le fou f5"] },
    mistakes: ["…e6 avant …Bf5 : le fou reste enfermé.", "Garder c4 par …b5 sans préparation : a4 et b3 le récupèrent."],
    traps: [T.qgaB5],
  },
  kid: {
    structures: [{ title: "Le centre bloqué d5-e4 contre d6-e5", moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7", text: "Après d5 le centre est fermé : les Blancs attaquent à l'aile dame (c5), les Noirs à l'aile roi (…f5-f4, …g5-g4). La course est lancée." }],
    plans: { me: ["…Ne8 ou …Nd7, …f5, …f4, …g5", "Garder le fou g7", "Sacrifices sur h3 ou g2 en fin d'attaque"], them: ["c5 et l'ouverture de la colonne c", "Bloquer l'aile roi (f3, g4)"] },
    mistakes: ["Ouvrir le centre trop tôt : les pièces blanches sont mieux placées.", "Attaquer avec trop peu de pièces."],
    traps: [],
  },
  nimzo: {
    structures: [{ title: "Les pions doublés c3-c4", moves: "d4 Nf6 c4 e6 Nc3 Bb4 a3 Bxc3+ bxc3 c5 e3 Nc6", text: "Les Blancs ont la paire de fous, les Noirs une meilleure structure : c4 est la cible (…Na5, …Ba6, …b6)." }],
    plans: { me: ["Contrôle de e4 (…d5, …Ne4, …b6/…Bb7)", "Pression sur c4", "Bloquer le centre si les Blancs ont la paire de fous"], them: ["Ouvrir le jeu pour les fous", "e4 et attaque à l'aile roi"] },
    mistakes: ["Donner le fou sans contrepartie structurelle.", "Laisser e4 se jouer sans combat."],
    traps: [],
  },
  dutch: {
    structures: [{ title: "La Leningrad", moves: "d4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O c4 d6", text: "Pion f5 et fou g7 : contrôle de e4 et e5 ; le plan …Qe8-h5, …e5 prépare l'attaque." }],
    plans: { me: ["…Qe8, …e5, …f4", "…Na6-c5 ou …Nc6", "…h6, …g5 si l'aile roi s'y prête"], them: ["d5 et b4-b5 à l'aile dame", "e4 pour ouvrir le centre"] },
    mistakes: ["Affaiblir la diagonale e8-h5 (piège …Rh6??).", "Oublier le gambit Staunton (2.e4)."],
    traps: [T.dutchMate],
  },
  londonb: {
    structures: [{ title: "La structure slave universelle", moves: "d4 d5 Nf3 Nf6 c4 c6 Nc3 dxc4", text: "La même mise en place contre tout : …d5, …Nf6, …c6 et le fou en f5 ou g4." }],
    plans: { me: ["Fou c8 dehors avant …e6", "…Nbd7, …Bd6, …e5", "…c5 contre les systèmes calmes"], them: ["e4 pour ouvrir", "Nh4 contre le fou f5"] },
    mistakes: ["…e6 trop tôt."],
    traps: [],
  },
  "d4-sidelines-black": {
    structures: [{ title: "Contre le Londres : …c5 et …Qb6", moves: "d4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 Qb6", text: "La pression sur b2 et d4 oblige les Blancs à se découvrir." }],
    plans: { me: ["…c5 rapide", "…Qb6 contre b2"], them: ["Structure solide puis Ne5"] },
    mistakes: ["…Qxb2 sans vérifier Nb5 et Rb1."],
    traps: [],
  },
};

export const courseOf = (id: string): Course | null => COURSES[id] ?? null;
