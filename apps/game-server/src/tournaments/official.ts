import type { SngSystem, TimeControlId } from "@chessarena/shared";

/**
 * Tournois officiels : programmés par le site, gratuits, toujours à l'heure (heure de Paris).
 * Le gestionnaire crée chaque édition ~26 h à l'avance pour qu'il y ait toujours un prochain rendez-vous affiché.
 */
export interface OfficialSpec {
  name: string;
  system: SngSystem;
  timeControl: TimeControlId;
  /** Arena : durée ; suisse : nombre de rondes */
  arenaMinutes?: number;
  rounds?: number;
  size: number;
  /** heure de Paris */
  hour: number;
  minute: number;
  /** jours (0 = dimanche) ; absent = tous les jours */
  days?: number[];
}

export const OFFICIAL_SCHEDULE: OfficialSpec[] = [
  { name: "Arena Blitz quotidienne", system: "arena", timeControl: "blitz_3_0", arenaMinutes: 45, size: 128, hour: 20, minute: 0 },
  { name: "Arena Bullet quotidienne", system: "arena", timeControl: "bullet_1_0", arenaMinutes: 30, size: 128, hour: 21, minute: 0 },
  { name: "Arena Rapide du week-end", system: "arena", timeControl: "rapid_5_0", arenaMinutes: 45, size: 128, hour: 12, minute: 30, days: [6, 0] },
  { name: "Grand Suisse du dimanche", system: "swiss", timeControl: "blitz_3_2", rounds: 7, size: 128, hour: 18, minute: 0, days: [0] },
];

/** Créées jusqu'à… à l'avance. */
export const OFFICIAL_LEAD_MS = 26 * 3600_000;

/** Décalage (ms) de l'heure de Paris par rapport à UTC à un instant donné (heure d'été comprise). */
export function parisOffsetMs(utcMs: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Instant UTC correspondant à une date et une heure de Paris. */
export function parisTime(y: number, m: number, d: number, hour: number, minute: number): number {
  const guess = Date.UTC(y, m, d, hour, minute);
  const first = guess - parisOffsetMs(guess);
  return guess - parisOffsetMs(first);
}

/** Éditions à créer : départs dans ]now + minLead, now + lead], triés. */
export function upcomingOfficial(now: number, minLeadMs: number, schedule: readonly OfficialSpec[] = OFFICIAL_SCHEDULE, leadMs = OFFICIAL_LEAD_MS): Array<{ spec: OfficialSpec; startsAt: string }> {
  const out: Array<{ spec: OfficialSpec; startsAt: string }> = [];
  const today = new Date(now + parisOffsetMs(now)); // date du jour à Paris
  for (let k = 0; k <= 2; k++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + k));
    for (const spec of schedule) {
      if (spec.days && !spec.days.includes(day.getUTCDay())) continue;
      const at = parisTime(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), spec.hour, spec.minute);
      if (at - now > minLeadMs && at - now <= leadMs) out.push({ spec, startsAt: new Date(at).toISOString() });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
