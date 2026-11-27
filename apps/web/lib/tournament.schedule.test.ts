import { describe, expect, it } from "vitest";
import { defaultStart, startsIn } from "./tournament";

describe("tournois programmés : textes", () => {
  it("compte à rebours lisible", () => {
    const now = Date.parse("2026-11-28T10:00:00Z");
    expect(startsIn("2026-11-28T10:00:30Z", now)).toBe("dans 30 s");
    expect(startsIn("2026-11-28T10:45:00Z", now)).toBe("dans 45 min");
    expect(startsIn("2026-11-28T12:05:00Z", now)).toBe("dans 2 h 05");
    expect(startsIn("2026-11-28T13:00:00Z", now)).toBe("dans 3 h");
    expect(startsIn("2026-12-01T10:00:00Z", now)).toBe("dans 3 jours");
    expect(startsIn("2026-11-28T09:00:00Z", now)).toBe("imminent");
  });
  it("par défaut : ce soir 20:00, ou demain s'il est trop tard", () => {
    expect(defaultStart(new Date(2026, 10, 28, 15, 0))).toBe("2026-11-28T20:00");
    expect(defaultStart(new Date(2026, 10, 28, 19, 45))).toBe("2026-11-29T20:00");
    expect(defaultStart(new Date(2026, 11, 31, 22, 0))).toBe("2027-01-01T20:00");
  });
});
