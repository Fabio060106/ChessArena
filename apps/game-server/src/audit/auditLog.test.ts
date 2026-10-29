import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, FileAuditLog, GENESIS_HASH, hashEntry, verifyChain, type AuditEntry } from "./auditLog.js";

async function sample(n = 4): Promise<AuditEntry[]> {
  const file = join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl");
  const log = new FileAuditLog(file);
  for (let i = 1; i <= n; i++) log.append("game.move", { gameId: "g", ply: i, uci: `m${i}`, extra: undefined });
  await log.close();
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
}

describe("canonical / hashEntry", () => {
  it("indépendant de l'ordre des clés, ignore undefined", () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(canonical({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });
  it("une modification d'un seul caractère change le hash", () => {
    const base = { seq: 1, ts: "2026-01-01T00:00:00.000Z", type: "game.move" as const, payload: { uci: "e2e4" }, prevHash: GENESIS_HASH };
    expect(hashEntry(base)).not.toBe(hashEntry({ ...base, payload: { uci: "e2e5" } }));
  });
});

describe("verifyChain", () => {
  it("valide une chaîne intacte et retourne sa tête", async () => {
    const e = await sample();
    expect(verifyChain(e)).toEqual({ ok: true, checked: 4, headHash: e[3]!.hash });
  });

  it("détecte une modification, une suppression, un réordonnancement, une insertion", async () => {
    const e = await sample();
    const modified = structuredClone(e);
    (modified[1]!.payload as { uci: string }).uci = "TRICHE";
    expect(verifyChain(modified)).toMatchObject({ ok: false, brokenAt: 2, reason: expect.stringContaining("contenu modifié") });

    expect(verifyChain([e[0]!, e[2]!, e[3]!])).toMatchObject({ ok: false, brokenAt: 2 });
    expect(verifyChain([e[0]!, e[2]!, e[1]!, e[3]!])).toMatchObject({ ok: false, brokenAt: 2 });

    // insertion d'une entrée forgée avec un hash cohérent… mais tout l'aval casse
    const forged = { ...e[1]!, payload: { forged: true } };
    forged.hash = hashEntry({ seq: forged.seq, ts: forged.ts, type: forged.type, payload: forged.payload, prevHash: forged.prevHash });
    expect(verifyChain([e[0]!, forged, e[2]!, e[3]!])).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it("reprend une vérification à partir d'un point de contrôle", async () => {
    const e = await sample(6);
    const first = verifyChain(e.slice(0, 3));
    expect(first.ok).toBe(true);
    expect(verifyChain(e.slice(3), { seq: 3, hash: (first as { headHash: string }).headHash })).toMatchObject({ ok: true, checked: 3 });
  });
});
