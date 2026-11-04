/** Aides d'affichage des profils joueurs — pures, testées. */

/** Drapeau emoji depuis un code ISO alpha-2 (« FR » → 🇫🇷). null si le code est invalide. */
export function flagEmoji(code: string | undefined): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  const up = code.toUpperCase();
  return String.fromCodePoint(...[...up].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryName(code: string | undefined, locale = "fr"): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

/** Avatar généré : initiales + teinte stable dérivée de l'identifiant (aucune image tierce). */
export function avatarFor(userId: string): { initials: string; hue: number } {
  let h = 2166136261;
  for (const ch of userId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const parts = userId.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
  return { initials, hue: Math.abs(h) % 360 };
}

export type PingQuality = "good" | "fair" | "poor" | "unknown";

/** Qualité de connexion pour un RTT : bon < 80 ms, correct < 180 ms, mauvais au-delà. */
export function pingQuality(rttMs: number | null | undefined): PingQuality {
  if (rttMs === null || rttMs === undefined) return "unknown";
  if (rttMs < 80) return "good";
  if (rttMs < 180) return "fair";
  return "poor";
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Avantage matériel du camp `color` (en points) d'après la FEN ; 0 si égal ou en retard. */
export function materialAdvantage(fen: string, color: "w" | "b"): number {
  let w = 0;
  let b = 0;
  for (const ch of fen.split(" ")[0]!) {
    const v = VALUE[ch.toLowerCase()];
    if (v === undefined) continue;
    if (ch === ch.toUpperCase()) w += v; else b += v;
  }
  const d = color === "w" ? w - b : b - w;
  return Math.max(0, d);
}
