/** Niveaux de l'ordinateur : force Stockfish (Skill Level) et profondeur ; Elo indicatif. */
export const BOT_LEVELS = [
  { level: 1, skill: 0, depth: 1, elo: 800, label: "Débutant" },
  { level: 2, skill: 2, depth: 2, elo: 1000, label: "Novice" },
  { level: 3, skill: 5, depth: 3, elo: 1200, label: "Club" },
  { level: 4, skill: 8, depth: 5, elo: 1400, label: "Bon joueur de club" },
  { level: 5, skill: 11, depth: 7, elo: 1600, label: "Confirmé" },
  { level: 6, skill: 14, depth: 9, elo: 1800, label: "Fort" },
  { level: 7, skill: 17, depth: 11, elo: 2100, label: "Expert" },
  { level: 8, skill: 20, depth: 14, elo: 2500, label: "Maître" },
] as const;

export type BotLevel = (typeof BOT_LEVELS)[number];

export function botLevel(n: number): BotLevel {
  return BOT_LEVELS[Math.max(0, Math.min(BOT_LEVELS.length - 1, Math.round(n) - 1))]!;
}

/** Délai « humain » avant que l'ordinateur joue (ms) : rapide en ouverture, un peu plus ensuite. */
export function botDelay(ply: number, random: () => number = Math.random): number {
  const base = ply < 8 ? 250 : 500;
  return Math.round(base + random() * 500);
}

/** Lien d'analyse de la partie (page Analyse : ?m=e2e4,e7e5…). */
export const analysisLink = (ucis: readonly string[]) => `/analyse?m=${ucis.join(",")}`;
