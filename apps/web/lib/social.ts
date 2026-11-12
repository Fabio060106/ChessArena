import type { TimeControlId } from "@chessarena/shared";

export const TC_LABEL: Record<TimeControlId, string> = {
  bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0",
};
export const TC_ORDER: TimeControlId[] = ["bullet_1_0", "blitz_3_0", "blitz_3_2", "rapid_5_0"];

/** Pourcentage arrondi (0 si aucune partie). */
export const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

/** Pseudo valide dans une URL de profil. */
export const isPseudo = (s: string) => s.length >= 1 && s.length <= 64 && !/[\s/]/.test(s);
