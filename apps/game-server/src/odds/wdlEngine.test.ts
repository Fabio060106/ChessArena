import { describe, expect, it } from "vitest";
import { defaultEngineCommand, parseWdlLine, WdlEngine } from "./wdlEngine.js";

describe("moteur WDL", () => {
  it("lit la ligne info de Stockfish (wdl, cp, profondeur) ; ignore les bornes et les lignes secondaires", () => {
    expect(parseWdlLine("info depth 18 seldepth 25 multipv 1 score cp 34 wdl 120 840 40 nodes 1 pv e2e4")).toEqual({ wdl: { w: 120, d: 840, l: 40 }, cp: 34, depth: 18 });
    expect(parseWdlLine("info depth 18 multipv 2 score cp 10 wdl 1 2 3")).toBeNull();
    expect(parseWdlLine("info depth 18 score cp 34 lowerbound wdl 1 2 3")).toBeNull();
    expect(parseWdlLine("bestmove e2e4")).toBeNull();
  });

  const cmd = defaultEngineCommand();
  it.skipIf(!cmd)("vrai Stockfish : les Blancs avec une dame de plus gagnent ; le point de vue suit le camp au trait", async () => {
    const e = new WdlEngine(cmd!, 300);
    try {
      const white = await e.evaluate("4k3/8/8/8/8/8/8/3QK3 w - - 0 1");
      expect(white!.wdl.w).toBeGreaterThan(900);
      const blackToMove = await e.evaluate("4k3/8/8/8/8/8/8/3QK3 b - - 0 1");
      expect(blackToMove!.wdl.w).toBeGreaterThan(900); // toujours du point de vue des Blancs
    } finally { e.close(); }
  }, 30_000);
});
