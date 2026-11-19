import { describe, expect, it, vi } from "vitest";
import { ChallengeService } from "./ChallengeService.js";

describe("ChallengeService", () => {
  it("un seul défi sortant par joueur, retrait unique, expiration", () => {
    vi.useFakeTimers();
    const expired: string[] = [];
    const s = new ChallengeService((c) => expired.push(c.id), 1000);
    const a = s.create("a", "b", "blitz_3_0");
    const a2 = s.create("a", "c", "rapid_5_0");
    expect(s.get(a.id)).toBeNull();
    expect(s.incomingFor("c").map((c) => c.id)).toEqual([a2.id]);
    const d = s.create("d", "c", "bullet_1_0");
    expect(s.involving("c").length).toBe(2);
    expect(s.remove(d.id)).toBe(true);
    expect(s.remove(d.id)).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(expired).toEqual([a2.id]);
    expect(s.get(a2.id)).toBeNull();
    vi.useRealTimers();
  });
});
