import { describe, expect, it } from "vitest";
import { filterTournaments, NO_FILTER, paceOf, pickOfficial } from "./tournament";
import { OFFICIAL_CREATOR, type TournamentCard } from "@chessarena/shared";

const t = (id: string, system: string, timeControl: string, players: number, size: number, status = "registering") => ({ id, system, timeControl, players, size, status });
const list = [t("s", "swiss", "blitz_3_0", 3, 8), t("a", "arena", "bullet_1_0", 40, 128), t("k", "ko", "rapid_5_0", 4, 4), t("f", "swiss", "blitz_3_2", 8, 8)];

describe("filtres de la vitrine des tournois", () => {
  it("cadence d'après l'identifiant", () => {
    expect([paceOf("bullet_1_0"), paceOf("blitz_3_2"), paceOf("rapid_5_0"), paceOf("rapid_10_0")]).toEqual(["bullet", "blitz", "rapid", "rapid"]);
  });
  it("sans filtre : tout ; par format ; par cadence ; places libres (l'Arena reste ouverte)", () => {
    const ids = (f: Partial<typeof NO_FILTER>) => filterTournaments(list, { ...NO_FILTER, ...f }).map((x) => x.id);
    expect(ids({})).toEqual(["s", "a", "k", "f"]);
    expect(ids({ system: "swiss" })).toEqual(["s", "f"]);
    expect(ids({ pace: "blitz" })).toEqual(["s", "f"]);
    expect(ids({ open: true })).toEqual(["s", "a"]);
    expect(ids({ system: "swiss", pace: "blitz", open: true })).toEqual(["s"]);
  });
});

describe("bandeau du tournoi officiel", () => {
  const now = Date.parse("2026-11-28T10:00:00Z");
  const card = (id: string, o: Partial<TournamentCard>) => ({ id, createdBy: OFFICIAL_CREATOR, system: "arena", status: "registering", startsAt: null, arenaEndsAt: null, ...o }) as TournamentCard;
  it("l'Arena officielle en cours d'abord (s'il reste plus de 3 min), sinon le prochain départ dans les 12 h ; jamais un tournoi de joueur", () => {
    const later = card("later", { startsAt: "2026-11-28T19:00:00Z" });
    const soon = card("soon", { startsAt: "2026-11-28T12:00:00Z" });
    const player = card("player", { createdBy: "bob", startsAt: "2026-11-28T10:30:00Z" });
    const far = card("far", { startsAt: "2026-11-29T10:30:00Z" });
    const live = card("live", { status: "running", arenaEndsAt: "2026-11-28T10:20:00Z" });
    const ending = card("ending", { status: "running", arenaEndsAt: "2026-11-28T10:02:00Z" });
    expect(pickOfficial({ upcoming: [later, soon, player, far], running: [ending, live], finished: [] }, now)?.id).toBe("live");
    expect(pickOfficial({ upcoming: [later, soon, player, far], running: [ending], finished: [] }, now)?.id).toBe("soon");
    expect(pickOfficial({ upcoming: [player, far], running: [], finished: [] }, now)).toBeNull();
  });
});
