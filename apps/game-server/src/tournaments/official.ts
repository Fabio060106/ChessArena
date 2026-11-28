import type { SngSystem, TimeControlId } from "@chessarena/shared";

/**
 * Tournois officiels : programmés par le site, à entrée payante (jetons pendant la bêta) avec une dotation garantie
 * ajoutée par le site, toujours à l'heure (heure de Paris). Rake de 10 % sur les entrées, pas sur la dotation.
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
  /** entrée (centimes de jetons) et dotation garantie ajoutée par le site (non rakée) */
  buyInCents: number;
  addedCents: number;
}

export const OFFICIAL_SCHEDULE: OfficialSpec[] = [
  { name: "Suisse Blitz du soir", system: "swiss", timeControl: "blitz_3_2", rounds: 5, size: 64, hour: 20, minute: 0, buyInCents: 500, addedCents: 5_000 },
  { name: "KO Bullet de 21 h 30", system: "ko", timeControl: "bullet_1_0", size: 16, hour: 21, minute: 30, buyInCents: 200, addedCents: 2_000 },
  { name: "Rapide du week-end", system: "swiss", timeControl: "rapid_5_0", rounds: 6, size: 64, hour: 12, minute: 30, days: [6, 0], buyInCents: 500, addedCents: 5_000 },
  { name: "Grand Suisse du dimanche", system: "swiss", timeControl: "blitz_3_2", rounds: 7, size: 128, hour: 18, minute: 0, days: [0], buyInCents: 1_000, addedCents: 20_000 },
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
