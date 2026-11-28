import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_CODE_RE, OpenChallengeService } from "./OpenChallengeService.js";

describe("défis par lien", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("code lisible de 8 caractères ; un seul lien par joueur ; consommé une seule fois", () => {
    const s = new OpenChallengeService();
    const a = s.create("alice", "blitz_3_0");
    expect(a.code).toMatch(LINK_CODE_RE);
    const b = s.create("alice", "rapid_5_0");
    expect(s.get(a.code)).toBeNull(); // remplacé
    expect(s.of("alice")).toMatchObject({ code: b.code, timeControl: "rapid_5_0" });
    expect(s.remove(b.code)).toBe(true);
    expect(s.remove(b.code)).toBe(false);
  });

  it("expire au bout de 30 min (prévenu)", () => {
    const gone: string[] = [];
    const s = new OpenChallengeService(30 * 60_000, (c) => gone.push(c.code));
    const a = s.create("bob", "bullet_1_0");
    expect(s.expiresAt(a)).toBe(a.createdAt + 30 * 60_000);
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(s.get(a.code)).toBeNull();
    expect(gone).toEqual([a.code]);
  });
});
