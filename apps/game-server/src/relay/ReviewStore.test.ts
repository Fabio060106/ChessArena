import { describe, expect, it } from "vitest";
import { InMemoryReviewStore, REVIEW_VERSION, validReview } from "./ReviewStore.js";

describe("analyses partagées", () => {
  const sans = ["e4", "e5", "Nf3"];
  const ok = { version: REVIEW_VERSION, summary: "Nulle.", moves: sans.map((san, i) => ({ ply: i + 1, san, comment: "…" })) };
  it("format vérifié : version, mêmes coups, taille bornée", () => {
    expect(validReview(ok, sans)).toBe(true);
    expect(validReview({ ...ok, version: 1 }, sans)).toBe(false);
    expect(validReview(ok, ["e4", "e5", "Nc3"])).toBe(false);
    expect(validReview({ ...ok, moves: ok.moves.slice(1) }, sans)).toBe(false);
    expect(validReview({ ...ok, summary: "x".repeat(500_000) }, sans)).toBe(false);
    expect(validReview(null, sans)).toBe(false);
  });
  it("la première analyse est gardée", async () => {
    const s = new InMemoryReviewStore();
    expect(await s.putIfAbsent("k", { a: 1 }, "u")).toBe(true);
    expect(await s.putIfAbsent("k", { a: 2 }, "v")).toBe(false);
    expect(await s.get("k")).toEqual({ a: 1 });
  });
});
