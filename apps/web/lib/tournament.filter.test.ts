import { describe, expect, it } from "vitest";
import { filterTournaments, NO_FILTER, paceOf } from "./tournament";

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
