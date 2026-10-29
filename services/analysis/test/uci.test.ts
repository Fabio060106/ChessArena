import { afterAll, describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { EngineCrashedError, EnginePool, EngineTimeoutError, MATE_CP, UciEngine } from "../src/uci.js";
import { testEngineCommand } from "./engine.js";

const command = testEngineCommand();

describe.skipIf(!command)("UCI — Stockfish 19 réel", () => {
  const pools: EnginePool[] = [];
  afterAll(() => pools.forEach((p) => p.close()));

  it("s'identifie, évalue et propose un coup légal", async () => {
    const e = new UciEngine({ command: command! });
    await e.init();
    expect(e.name).toMatch(/Stockfish 19/);
    const fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
    const r = await e.evaluate(fen, 8);
    const legal = new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""));
    expect(legal).toContain(r.bestMove);
    expect(Math.abs(r.cp)).toBeLessThan(300);
    e.quit();
  });

  it("détecte un mat en 1 (point de vue du camp au trait)", async () => {
    const e = new UciEngine({ command: command! });
    await e.init();
    const r = await e.evaluate("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", 6);
    expect(r).toMatchObject({ mate: 1, cp: MATE_CP - 1, bestMove: "a1a8" });
    e.quit();
  });

  it("délai dépassé : erreur typée, processus tué", async () => {
    const e = new UciEngine({ command: command!, evalTimeoutMs: 50 });
    await e.init();
    await expect(e.evaluate("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", 30)).rejects.toBeInstanceOf(EngineTimeoutError);
    expect(e.alive).toBe(false);
  });

  it("pool : un moteur tué en pleine analyse est remplacé, le pool reste pleinement opérationnel", async () => {
    const pool = new EnginePool({ command: command!, size: 2 });
    pools.push(pool);
    await pool.init();
    expect(pool.available).toBe(2);
    await expect(pool.use(async (e) => {
      setTimeout(() => e.kill(), 20);
      return e.evaluate("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", 40);
    })).rejects.toBeInstanceOf(EngineCrashedError);
    expect(pool.replaced).toBe(1);
    expect(pool.available).toBe(2);
    // les deux moteurs répondent, en parallèle
    const results = await Promise.all([1, 2, 3, 4].map(() => pool.use((e) => e.evaluate("8/8/8/4k3/8/8/4K3/4Q3 w - - 0 1", 6))));
    expect(results.every((r) => r.cp > 500)).toBe(true);
  });
});
