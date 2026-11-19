import { describe, expect, it } from "vitest";
import { challengeError, outcomeText } from "./challenges";
import { lowTimeThreshold } from "./clock";

describe("défis et alerte de temps", () => {
  it("messages clairs pour chaque refus", () => {
    expect(challengeError("OFFLINE", "Raph")).toBe("Raph n'est pas connecté en ce moment.");
    expect(challengeError("OPPONENT_BUSY", "Raph")).toBe("Raph est déjà en partie.");
    expect(challengeError("???")).toMatch(/impossible/);
    expect(outcomeText({ id: "1", status: "declined" }, "Raph")).toBe("Raph a refusé le défi.");
    expect(outcomeText({ id: "1", status: "expired" }, "Raph")).toBe("Raph n'a pas répondu à temps.");
    expect(outcomeText({ id: "1", status: "cancelled", reason: "IN_GAME" }, "Raph")).toBe("Raph est déjà en partie.");
    expect(outcomeText({ id: "1", status: "cancelled" }, "Raph")).toBeNull();
  });
  it("seuil d'alerte selon la cadence", () => {
    expect(lowTimeThreshold(60_000)).toBe(10_000);
    expect(lowTimeThreshold(180_000)).toBe(20_000);
    expect(lowTimeThreshold(300_000)).toBe(30_000);
  });
});
