import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepAwake } from "./keepAwake.js";

describe("serveur gardé éveillé (Render)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("seulement sur Render, désactivable ; visite /health à intervalle régulier", async () => {
    const calls: string[] = [];
    const f = (async (u: string) => { calls.push(u); return new Response("ok"); }) as unknown as typeof fetch;
    expect(keepAwake({}, 1000, f)).toBeNull();
    expect(keepAwake({ RENDER_EXTERNAL_URL: "https://x.onrender.com", KEEP_AWAKE: "0" }, 1000, f)).toBeNull();
    const stop = keepAwake({ RENDER_EXTERNAL_URL: "https://x.onrender.com/" }, 1000, f)!;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toEqual(["https://x.onrender.com/health", "https://x.onrender.com/health"]);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
  });
});
