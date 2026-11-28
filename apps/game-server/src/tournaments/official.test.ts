import { describe, expect, it } from "vitest";
import { parisOffsetMs, parisTime, upcomingOfficial, type OfficialSpec } from "./official.js";

describe("tournois officiels — calendrier (heure de Paris)", () => {
  it("décalage hiver / été", () => {
    expect(parisOffsetMs(Date.parse("2026-11-28T12:00:00Z"))).toBe(3600_000);
    expect(parisOffsetMs(Date.parse("2026-07-01T12:00:00Z"))).toBe(7200_000);
    expect(new Date(parisTime(2026, 10, 28, 20, 0)).toISOString()).toBe("2026-11-28T19:00:00.000Z");
    expect(new Date(parisTime(2026, 6, 1, 20, 0)).toISOString()).toBe("2026-07-01T18:00:00.000Z");
    // passage à l'heure d'été (29 mars 2026, 2 h → 3 h)
    expect(new Date(parisTime(2026, 2, 29, 20, 0)).toISOString()).toBe("2026-03-29T18:00:00.000Z");
  });

  const daily: OfficialSpec = { name: "Soir", system: "arena", timeControl: "blitz_3_0", arenaMinutes: 45, size: 128, hour: 20, minute: 0, buyInCents: 0, addedCents: 0 };
  const sunday: OfficialSpec = { name: "Dimanche", system: "swiss", timeControl: "blitz_3_2", rounds: 7, size: 128, hour: 18, minute: 0, days: [0], buyInCents: 0, addedCents: 0 };

  it("éditions des prochaines 26 h, ni trop proches ni déjà passées ; jours de la semaine respectés", () => {
    const now = Date.parse("2026-11-28T10:00:00Z"); // samedi 11 h à Paris : dimanche 18 h est à 31 h, trop loin
    expect(upcomingOfficial(now, 120_000, [daily, sunday]).map((x) => `${x.spec.name} ${x.startsAt}`)).toEqual(["Soir 2026-11-28T19:00:00.000Z"]);
    const evening = Date.parse("2026-11-28T18:00:00Z"); // samedi 19 h : ce soir, dimanche 18 h, dimanche soir
    expect(upcomingOfficial(evening, 120_000, [daily, sunday]).map((x) => `${x.spec.name} ${x.startsAt}`)).toEqual([
      "Soir 2026-11-28T19:00:00.000Z", "Dimanche 2026-11-29T17:00:00.000Z", "Soir 2026-11-29T19:00:00.000Z",
    ]);
    // samedi 20 h 01 à Paris : celle du soir est partie, la suivante est demain
    const late = Date.parse("2026-11-28T19:01:00Z");
    expect(upcomingOfficial(late, 120_000, [daily]).map((x) => x.startsAt)).toEqual(["2026-11-29T19:00:00.000Z"]);
    // une minute avant le départ : celle du soir est trop proche pour être créée, celle du lendemain l'est
    expect(upcomingOfficial(Date.parse("2026-11-28T18:59:00Z"), 120_000, [daily]).map((x) => x.startsAt)).toEqual(["2026-11-29T19:00:00.000Z"]);
  });
});
