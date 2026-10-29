import { test } from "vitest";
import assert from "node:assert/strict";
import { computeRake, settleDuel, settleTournament, SIT_AND_GO_STRUCTURES } from "./rake.js";

test("rake 10 % sur un duel 2 € + 2 €", () => {
  const p = settleDuel(200, "alice", "bob", "white", 1000);
  assert.equal(p.potCents, 400);
  assert.equal(p.rakeCents, 40);
  assert.deepEqual(p.payouts, { alice: 360, bob: 0 });
});

test("arrondi en faveur du joueur", () => {
  assert.equal(computeRake(333, 1000), 33); // 33,3 → 33
});

test("nulle : centime résiduel au joueur blanc, invariant respecté", () => {
  const p = settleDuel(155, "w", "b", "draw", 1000); // pot 310, rake 31, net 279
  assert.equal(p.payouts.w! + p.payouts.b! + p.rakeCents, 310);
  assert.equal(p.payouts.w, 140);
  assert.equal(p.payouts.b, 139);
});

test("partie annulée : remboursement intégral, pas de rake", () => {
  const p = settleDuel(500, "w", "b", "aborted", 1000);
  assert.equal(p.rakeCents, 0);
  assert.deepEqual(p.payouts, { w: 500, b: 500 });
});

test("Sit & Go 8 joueurs à 5 € + dotation streamer 20 € non rakée", () => {
  const ranking = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
  const p = settleTournament(500, 8, ranking, SIT_AND_GO_STRUCTURES[8]!, 1000, 2000);
  assert.equal(p.rakeCents, 400); // 10 % de 40 €
  assert.equal(p.payouts.p1! + p.payouts.p2!, 4000 - 400 + 2000);
});

test("structure ≠ 100 % rejetée", () => {
  assert.throws(() => settleTournament(500, 4, ["a", "b", "c", "d"], [5000, 4000], 1000));
});
