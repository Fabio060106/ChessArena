import type { TimeControlId } from "@chessarena/shared";

export const stakeLabel = (cents: number) => (cents === 0 ? "Gratuit" : `${(cents / 100).toFixed(0)} jeton${cents > 100 ? "s" : ""}`);

/**
 * Qui attend à une cadence, d'après les compteurs du serveur (clé « cadence|PLAY|mise ») :
 * `same` = à la mise choisie, `other` = aux autres mises. `mine` = ma mise si je suis moi-même dans
 * une file de cette cadence (je ne me compte pas).
 */
export function waitingFor(stats: Record<string, number>, tc: TimeControlId, stake: number, mine: number | null): {
  same: number; other: Array<{ stake: number; count: number }>;
} {
  let same = 0;
  const other: Array<{ stake: number; count: number }> = [];
  for (const [key, n] of Object.entries(stats)) {
    const [t, cur, cents] = key.split("|");
    if (t !== tc || cur !== "PLAY") continue;
    const s = Number(cents);
    const count = n - (mine === s ? 1 : 0);
    if (count <= 0) continue;
    if (s === stake) same += count;
    else other.push({ stake: s, count });
  }
  other.sort((a, b) => a.stake - b.stake);
  return { same, other };
}
