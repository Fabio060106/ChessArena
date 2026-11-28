import { describe, expect, it } from "vitest";
import { analysisLink, BOT_LEVELS, botDelay, botLevel } from "./bot";

describe("ordinateur", () => {
  it("8 niveaux de plus en plus forts ; niveaux hors bornes ramenés", () => {
    expect(BOT_LEVELS).toHaveLength(8);
    for (let i = 1; i < BOT_LEVELS.length; i++) {
      expect(BOT_LEVELS[i]!.skill).toBeGreaterThan(BOT_LEVELS[i - 1]!.skill);
      expect(BOT_LEVELS[i]!.depth).toBeGreaterThan(BOT_LEVELS[i - 1]!.depth);
    }
    expect(botLevel(0).level).toBe(1);
    expect(botLevel(99).level).toBe(8);
  });
  it("délai entre 250 et 1000 ms ; lien d'analyse", () => {
    expect(botDelay(0, () => 0)).toBe(250);
    expect(botDelay(20, () => 1)).toBe(1000);
    expect(analysisLink(["e2e4", "e7e5"])).toBe("/analyse?m=e2e4,e7e5");
  });
});
