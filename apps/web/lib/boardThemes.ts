/**
 * Thèmes d'échiquier. Chaque thème est un jeu de variables CSS posées sur le plateau :
 * aucun composant ne contient de couleur en dur, changer de thème ne remonte aucun élément.
 */
export type BoardThemeId = "cyberpunk" | "slate" | "wood";

export interface BoardTheme {
  id: BoardThemeId;
  label: string;
  vars: Record<`--${string}`, string>;
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
      "--pw-0": "#F7F9FF", "--pw-1": "#AEB9DA", "--pw-stroke": "#0B0E14", "--pw-detail": "#0B0E14",
      "--pb-0": "#30365A", "--pb-1": "#0F1222", "--pb-stroke": "#3DF2FF", "--pb-detail": "#3DF2FF",
    },
  },
  slate: {
    id: "slate",
    label: "Modern Slate",
    vars: {
      "--sq-light": "#C5CDD8",
      "--sq-dark": "#66758C",
      "--board-overlay": "linear-gradient(180deg, rgba(255,255,255,.05), transparent 60%)",
      "--board-ring": "0 0 0 1px rgba(255,255,255,.08), 0 24px 60px -20px rgba(0,0,0,.75)",
      "--coord-light": "rgba(70,84,106,.9)",
      "--coord-dark": "rgba(228,234,242,.85)",
      "--hl-last": "rgba(255,206,84,.42)",
      "--hl-last-ring": "none",
      "--hl-selected": "rgba(84,160,255,.5)",
      "--hl-premove": "rgba(138,96,255,.45)",
      "--hl-premove-ring": "inset 0 0 0 2px rgba(138,96,255,.8)",
      "--hl-hover": "inset 0 0 0 3px rgba(255,255,255,.75)",
      "--hl-check": "radial-gradient(circle, rgba(240,52,52,.95) 0%, rgba(240,52,52,.45) 45%, transparent 72%)",
      "--dot-move": "rgba(20,30,48,.35)",
      "--dot-premove": "rgba(138,96,255,.7)",
      "--pw-0": "#FFFFFF", "--pw-1": "#D3D9E3", "--pw-stroke": "#1A202C", "--pw-detail": "#1A202C",
      "--pb-0": "#3B4456", "--pb-1": "#151A24", "--pb-stroke": "#0B0E14", "--pb-detail": "#C5CDD8",
    },
  },
  wood: {
    id: "wood",
    label: "Wood Classic",
    vars: {
      "--sq-light": "#EBD3A8",
      "--sq-dark": "#B07D4F",
      "--board-overlay": "repeating-linear-gradient(100deg, rgba(90,50,20,.05) 0 2px, transparent 2px 9px), linear-gradient(180deg, rgba(255,240,210,.08), rgba(60,30,10,.08))",
      "--board-ring": "0 0 0 1px rgba(60,30,10,.6), 0 24px 60px -20px rgba(0,0,0,.75)",
      "--coord-light": "rgba(140,92,52,.95)",
      "--coord-dark": "rgba(246,226,190,.95)",
      "--hl-last": "rgba(205,210,90,.55)",
      "--hl-last-ring": "none",
      "--hl-selected": "rgba(110,160,70,.6)",
      "--hl-premove": "rgba(70,110,200,.45)",
      "--hl-premove-ring": "inset 0 0 0 2px rgba(70,110,200,.75)",
      "--hl-hover": "inset 0 0 0 3px rgba(255,250,235,.8)",
      "--hl-check": "radial-gradient(circle, rgba(220,30,30,.95) 0%, rgba(220,30,30,.45) 45%, transparent 72%)",
      "--dot-move": "rgba(60,30,10,.32)",
      "--dot-premove": "rgba(70,110,200,.7)",
      "--pw-0": "#FFFAF0", "--pw-1": "#E2D1B3", "--pw-stroke": "#3A2716", "--pw-detail": "#3A2716",
      "--pb-0": "#4C3526", "--pb-1": "#1C120B", "--pb-stroke": "#120A05", "--pb-detail": "#E9D3AE",
    },
  },
};

export const THEME_ORDER: BoardThemeId[] = ["cyberpunk", "slate", "wood"];

export function isBoardTheme(v: unknown): v is BoardThemeId {
  return typeof v === "string" && v in BOARD_THEMES;
}
