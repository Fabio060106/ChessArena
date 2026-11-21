import { describe, expect, it } from "vitest";
import { stakeLabel, waitingFor } from "./queue";

describe("file d'attente : qui attend où", () => {
  const stats = { "blitz_3_0|PLAY|0": 1, "blitz_3_0|PLAY|200": 2, "bullet_1_0|PLAY|0": 1, "blitz_3_0|EUR|200": 3 };
  it("compte les joueurs à ma mise et aux autres, sans me compter", () => {
    expect(waitingFor(stats, "blitz_3_0", 0, null)).toEqual({ same: 1, other: [{ stake: 200, count: 2 }] });
    expect(waitingFor(stats, "blitz_3_0", 200, 200)).toEqual({ same: 1, other: [{ stake: 0, count: 1 }] });
    expect(waitingFor(stats, "blitz_3_0", 0, 0)).toEqual({ same: 0, other: [{ stake: 200, count: 2 }] });
    expect(waitingFor(stats, "rapid_5_0", 0, null)).toEqual({ same: 0, other: [] });
  });
  it("libellés", () => {
    expect(stakeLabel(0)).toBe("Gratuit");
    expect(stakeLabel(100)).toBe("1 jeton");
    expect(stakeLabel(500)).toBe("5 jetons");
  });
});
