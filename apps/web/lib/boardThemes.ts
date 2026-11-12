/**
 * Apparence de l'échiquier, en trois choix INDÉPENDANTS (on peut aimer l'échiquier d'un thème et les pièces d'un autre) :
 *  - l'échiquier (cases, surbrillances, coordonnées) ;
 *  - la forme des pièces (jeux de pièces originaux, dessinés pour ChessArena) ;
 *  - les couleurs des pièces.
 * Tout passe par des variables CSS posées sur le plateau : changer d'apparence ne remonte aucun élément.
 */
type Vars = Record<`--${string}`, string>;

export type BoardThemeId =
  | "cyberpunk" | "slate" | "wood" | "brown" | "green" | "blue" | "grey" | "purple" | "coral" | "ice" | "marble" | "night" | "sand" | "pink";

export interface BoardTheme {
  id: BoardThemeId;
  label: string;
  vars: Vars;
}

/** Surbrillances par défaut d'un échiquier « classique » (cases claires / foncées unies). */
function classic(id: BoardThemeId, label: string, light: string, dark: string, extra: Partial<Vars> = {}): BoardTheme {
  return {
    id, label,
    vars: {
      "--sq-light": light,
      "--sq-dark": dark,
      "--board-overlay": "linear-gradient(180deg, rgba(255,255,255,.04), transparent 60%)",
      "--board-ring": "0 0 0 1px rgba(0,0,0,.35), 0 24px 60px -20px rgba(0,0,0,.75)",
      "--coord-light": dark,
      "--coord-dark": light,
      "--hl-last": "rgba(255,214,64,.42)",
      "--hl-last-ring": "none",
      "--hl-selected": "rgba(20,120,60,.5)",
      "--hl-premove": "rgba(90,90,220,.42)",
      "--hl-premove-ring": "inset 0 0 0 2px rgba(90,90,220,.75)",
      "--hl-hover": "inset 0 0 0 3px rgba(255,255,255,.75)",
      "--hl-check": "radial-gradient(circle, rgba(230,30,30,.95) 0%, rgba(230,30,30,.45) 45%, transparent 72%)",
      "--dot-move": "rgba(0,0,0,.28)",
      "--dot-premove": "rgba(90,90,220,.7)",
      ...extra,
    } as Vars,
  };
}

export const BOARD_THEMES: Record<BoardThemeId, BoardTheme> = {
  cyberpunk: {
    id: "cyberpunk",
    label: "Cyberpunk",
    vars: {
      "--sq-light": "#2B3554",
      "--sq-dark": "#161C30",
      "--board-overlay": "linear-gradient(135deg, rgba(0,229,255,.06), transparent 40%, rgba(255,46,180,.06))",
      "--board-ring": "0 0 0 1px rgba(0,229,255,.35), 0 0 32px -6px rgba(0,229,255,.45), 0 24px 60px -20px rgba(0,0,0,.8)",
      "--coord-light": "rgba(170,190,255,.55)",
      "--coord-dark": "rgba(170,190,255,.45)",
      "--hl-last": "rgba(0,229,255,.20)",
      "--hl-last-ring": "inset 0 0 0 2px rgba(0,229,255,.45)",
      "--hl-selected": "rgba(0,229,255,.32)",
      "--hl-premove": "rgba(255,46,180,.30)",
      "--hl-premove-ring": "inset 0 0 0 2px rgba(255,46,180,.7)",
      "--hl-hover": "inset 0 0 0 3px rgba(0,229,255,.8)",
      "--hl-check": "radial-gradient(circle, rgba(255,40,80,.95) 0%, rgba(255,40,80,.45) 45%, transparent 72%)",
      "--dot-move": "rgba(0,229,255,.55)",
      "--dot-premove": "rgba(255,46,180,.6)",
    },
  },
  slate: classic("slate", "Ardoise", "#C5CDD8", "#66758C", {
    "--coord-light": "rgba(70,84,106,.9)", "--coord-dark": "rgba(228,234,242,.85)",
    "--hl-selected": "rgba(84,160,255,.5)", "--hl-premove": "rgba(138,96,255,.45)", "--hl-premove-ring": "inset 0 0 0 2px rgba(138,96,255,.8)",
    "--dot-move": "rgba(20,30,48,.35)", "--dot-premove": "rgba(138,96,255,.7)",
  }),
  wood: classic("wood", "Bois", "#EBD3A8", "#B07D4F", {
    "--board-overlay": "repeating-linear-gradient(100deg, rgba(90,50,20,.05) 0 2px, transparent 2px 9px), linear-gradient(180deg, rgba(255,240,210,.08), rgba(60,30,10,.08))",
    "--board-ring": "0 0 0 1px rgba(60,30,10,.6), 0 24px 60px -20px rgba(0,0,0,.75)",
    "--coord-light": "rgba(140,92,52,.95)", "--coord-dark": "rgba(246,226,190,.95)",
    "--hl-last": "rgba(205,210,90,.55)", "--hl-selected": "rgba(110,160,70,.6)",
    "--dot-move": "rgba(60,30,10,.32)",
  }),
  brown: classic("brown", "Marron", "#F0D9B5", "#B58863", { "--hl-last": "rgba(205,210,106,.6)", "--hl-selected": "rgba(20,85,30,.5)" }),
  green: classic("green", "Tournoi vert", "#EEEED2", "#769656", { "--hl-last": "rgba(246,246,105,.55)", "--hl-selected": "rgba(186,202,68,.75)" }),
  blue: classic("blue", "Bleu", "#DEE3E6", "#8CA2AD", { "--hl-last": "rgba(155,199,0,.41)", "--hl-selected": "rgba(20,85,30,.45)" }),
  grey: classic("grey", "Gris", "#DADADA", "#8E8E8E", { "--hl-last": "rgba(255,190,60,.45)" }),
  purple: classic("purple", "Violet", "#E8DDF5", "#9478BC", { "--hl-last": "rgba(255,200,90,.5)", "--hl-selected": "rgba(255,255,255,.4)" }),
  coral: classic("coral", "Corail", "#F6E1D3", "#D58C70", { "--hl-last": "rgba(120,190,200,.5)", "--hl-selected": "rgba(40,110,120,.45)" }),
  ice: classic("ice", "Glace", "#EEF6FA", "#9DC3D6", {
    "--board-overlay": "linear-gradient(160deg, rgba(255,255,255,.25), transparent 45%, rgba(160,210,235,.15))",
    "--hl-last": "rgba(255,170,80,.45)", "--hl-selected": "rgba(40,120,170,.45)",
  }),
  marble: classic("marble", "Marbre", "#ECEAE4", "#A29E97", {
    "--board-overlay": "radial-gradient(ellipse at 22% 28%, rgba(255,255,255,.22), transparent 38%), radial-gradient(ellipse at 78% 70%, rgba(255,255,255,.14), transparent 35%), repeating-linear-gradient(32deg, rgba(60,60,60,.06) 0 1px, transparent 1px 13px), repeating-linear-gradient(-58deg, rgba(60,60,60,.04) 0 1px, transparent 1px 21px)",
    "--hl-last": "rgba(212,175,55,.45)", "--hl-selected": "rgba(60,90,140,.45)",
  }),
  night: classic("night", "Nuit", "#4B5367", "#2A303D", {
    "--board-ring": "0 0 0 1px rgba(255,255,255,.08), 0 24px 60px -20px rgba(0,0,0,.85)",
    "--coord-light": "rgba(200,210,230,.6)", "--coord-dark": "rgba(200,210,230,.5)",
    "--hl-last": "rgba(255,200,80,.28)", "--hl-selected": "rgba(120,170,255,.4)", "--dot-move": "rgba(255,255,255,.3)",
  }),
  sand: classic("sand", "Sable", "#F4E6C8", "#CDA66E", { "--hl-last": "rgba(120,170,90,.45)", "--hl-selected": "rgba(60,110,60,.5)" }),
  pink: classic("pink", "Rose", "#FBE4EC", "#E08BA8", { "--hl-last": "rgba(120,200,190,.5)", "--hl-selected": "rgba(150,40,90,.4)" }),
};

export const THEME_ORDER: BoardThemeId[] = [
  "cyberpunk", "slate", "wood", "brown", "green", "blue", "grey", "purple", "coral", "ice", "marble", "night", "sand", "pink",
];

export function isBoardTheme(v: unknown): v is BoardThemeId {
  return typeof v === "string" && v in BOARD_THEMES;
}

// ─── Couleurs des pièces ─────────────────────────────────────────────────────
export type PaletteId = "neon" | "slate" | "wood" | "ivory" | "maple" | "red" | "coral";

export interface PiecePalette {
  id: PaletteId;
  label: string;
  vars: Vars;
}

const pal = (id: PaletteId, label: string, w: [string, string, string, string], b: [string, string, string, string]): PiecePalette => ({
  id, label,
  vars: {
    "--pw-0": w[0], "--pw-1": w[1], "--pw-stroke": w[2], "--pw-detail": w[3],
    "--pb-0": b[0], "--pb-1": b[1], "--pb-stroke": b[2], "--pb-detail": b[3],
  },
});

export const PIECE_PALETTES: Record<PaletteId, PiecePalette> = {
  neon: pal("neon", "Néon", ["#F7F9FF", "#AEB9DA", "#0B0E14", "#0B0E14"], ["#30365A", "#0F1222", "#3DF2FF", "#3DF2FF"]),
  slate: pal("slate", "Ardoise", ["#FFFFFF", "#D3D9E3", "#1A202C", "#1A202C"], ["#3B4456", "#151A24", "#0B0E14", "#C5CDD8"]),
  wood: pal("wood", "Bois", ["#FFFAF0", "#E2D1B3", "#3A2716", "#3A2716"], ["#4C3526", "#1C120B", "#120A05", "#E9D3AE"]),
  ivory: pal("ivory", "Ivoire et ébène", ["#FFFFFF", "#E4E4E4", "#1E1E1E", "#1E1E1E"], ["#4A4A4A", "#121212", "#000000", "#EDEDED"]),
  maple: pal("maple", "Érable et noyer", ["#F7E4C2", "#D8B27A", "#4A2E14", "#4A2E14"], ["#7B4B2A", "#3A1F0E", "#1C0E05", "#F0D6B0"]),
  red: pal("red", "Ivoire et rouge", ["#FFF8EC", "#E7D9BF", "#3A2A1A", "#3A2A1A"], ["#C9412F", "#7A1A12", "#3A0805", "#FFE2D8"]),
  coral: pal("coral", "Corail et marine", ["#FFE6DA", "#F2967A", "#5B1E0E", "#5B1E0E"], ["#3C5F99", "#152849", "#09132A", "#C4DAFF"]),
};

export const PALETTE_ORDER: PaletteId[] = ["neon", "slate", "wood", "ivory", "maple", "red", "coral"];

export function isPalette(v: unknown): v is PaletteId {
  return typeof v === "string" && v in PIECE_PALETTES;
}

// ─── Formes des pièces ───────────────────────────────────────────────────────
export type PieceSetId = "arena" | "classic" | "flat" | "outline" | "pixel" | "letters" | "relief" | "sketch" | "crystal" | "turned" | "woodgrain" | "marble";

export const PIECE_SETS: Array<{ id: PieceSetId; label: string }> = [
  { id: "arena", label: "Arena" },
  { id: "classic", label: "Classique" },
  { id: "flat", label: "Épuré" },
  { id: "outline", label: "Contour" },
  { id: "pixel", label: "Pixel" },
  { id: "letters", label: "Lettres" },
  { id: "relief", label: "Relief" },
  { id: "sketch", label: "Croquis" },
  { id: "crystal", label: "Cristal" },
  { id: "turned", label: "Tourné" },
  { id: "woodgrain", label: "Bois veiné" },
  { id: "marble", label: "Marbre" },
];

export function isPieceSet(v: unknown): v is PieceSetId {
  return typeof v === "string" && PIECE_SETS.some((s) => s.id === v);
}

/** Les anciens réglages (un seul « thème ») gardent leurs couleurs de pièces. */
export function defaultPaletteFor(board: BoardThemeId): PaletteId {
  return board === "cyberpunk" ? "neon" : board === "wood" || board === "brown" || board === "sand" ? "wood" : board === "slate" || board === "night" ? "slate" : "ivory";
}

/** Variables CSS d'un plateau : échiquier + couleurs des pièces. */
export function boardVars(board: BoardThemeId, palette: PaletteId): Vars {
  return { ...(BOARD_THEMES[board] ?? BOARD_THEMES.cyberpunk).vars, ...(PIECE_PALETTES[palette] ?? PIECE_PALETTES.neon).vars };
}
