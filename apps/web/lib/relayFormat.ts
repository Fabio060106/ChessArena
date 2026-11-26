import type { RelayRoundRef, RelayStanding } from "@chessarena/shared";

/** 1.5 → « 1½ », 0.5 → « ½ » */
export function points(n: number): string {
  const whole = Math.floor(n);
  const half = n - whole >= 0.5;
  return half ? (whole ? `${whole}½` : "½") : String(whole);
}

/** Nom court d'un joueur (« Sindarov, Javokhir » → « Sindarov », « Gukesh D » → « Gukesh »). */
export function shortName(n: string): string {
  if (n.includes(",")) return n.split(",")[0]!.trim();
  const parts = n.trim().split(/\s+/);
  return parts.length > 1 && parts.at(-1)!.length <= 2 ? parts.slice(0, -1).join(" ") : parts.length > 2 ? parts.at(-1)! : n;
}

/** Score d'un match à deux joueurs : « Gukesh 1½ – 1½ Sindarov » (null s'il n'y a pas exactement deux joueurs). */
export function matchScore(s: readonly RelayStanding[] | undefined): { a: RelayStanding; b: RelayStanding; text: string } | null {
  if (!s || s.length !== 2) return null;
  const [a, b] = s as [RelayStanding, RelayStanding];
  return { a, b, text: `${shortName(a.name)} ${points(a.score)} – ${points(b.score)} ${shortName(b.name)}` };
}

/** Prochaine ronde à venir avec une heure connue. */
export function nextRound(rounds: readonly RelayRoundRef[] | undefined, now: number): RelayRoundRef | null {
  return (rounds ?? []).filter((r) => r.state === "upcoming" && typeof r.startsAt === "number" && r.startsAt > now - 3_600_000)
    .sort((x, y) => x.startsAt! - y.startsAt!)[0] ?? null;
}

/** « dans 2 h 15 », « dans 5 min », « imminent » */
export function untilText(at: number, now: number): string {
  const min = Math.round((at - now) / 60_000);
  if (min <= 0) return "imminent";
  if (min < 60) return `dans ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `dans ${h} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")}` : ""}`;
  return `dans ${Math.round(h / 24)} jours`;
}

/** Date et heure locales du spectateur : « jeu. 26 nov. à 10:00 » */
export function whenText(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}
