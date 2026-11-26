import { describe, expect, it } from "vitest";
import { ImportService, importedToRepertoire, lichessGamesUrl, parseLichessExport, validLichessName, type ImportedGame } from "./lichessImport.js";

const P = (name: string, rating: number) => ({ user: { name, id: name.toLowerCase() }, rating });
const line = (o: Record<string, unknown>) => JSON.stringify({ variant: "standard", speed: "blitz", createdAt: Date.UTC(2026, 10, 20, 18), status: "mate", ...o });
const NDJSON = [
  line({ id: "AAAAAAAA", players: { white: P("LeBaronRouge", 1800), black: P("Bob", 1750) }, winner: "white", opening: { eco: "C65", name: "Ruy Lopez: Berlin Defense" }, moves: "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O" }),
  line({ id: "BBBBBBBB", speed: "rapid", status: "draw", players: { white: P("Alice", 1900), black: P("LeBaronRouge", 1810) }, opening: { eco: "B90", name: "Sicilian Defense: Najdorf Variation" }, moves: "e4 c5 Nf3 d6 d4 cxd4" }),
  line({ id: "CCCCCCCC", status: "aborted", players: { white: P("LeBaronRouge", 1800), black: P("X", 1) }, moves: "e4" }),
  line({ id: "DDDDDDDD", variant: "chess960", players: { white: P("LeBaronRouge", 1800), black: P("Y", 1) }, winner: "black", moves: "e4 e5 Nf3 Nc6" }),
  line({ id: "EEEEEEEE", status: "resign", players: { white: { aiLevel: 5 }, black: P("LeBaronRouge", 1800) }, winner: "white", moves: "d4 d5 c4 e6 Nc3" }),
  "{ pas du json",
].join("\n");

describe("import Lichess", () => {
  it("lit l'export : parties standard terminées, couleur et résultat du point de vue du joueur", () => {
    const g = parseLichessExport(NDJSON, "lebaronrouge");
    expect(g.map((x) => [x.extId, x.color, x.outcome, x.speed])).toEqual([
      ["AAAAAAAA", "w", "win", "blitz"], ["BBBBBBBB", "b", "draw", "rapid"], ["EEEEEEEE", "b", "loss", "blitz"],
    ]);
    expect(g[0]!.opponent).toBe("Bob (1750)");
    expect(g[2]!.opponent).toBe("Stockfish niveau 5");
    expect(g[0]!.opening).toBe("Ruy Lopez: Berlin Defense");
    expect(g[0]!.pgn).toContain('[White "LeBaronRouge"]');
    expect(g[0]!.pgn).toContain("1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O 1-0");
    expect(g[1]!.pgn).toContain("1/2-1/2");
    expect(importedToRepertoire(g[1]!)).toMatchObject({ gameId: "lichess:BBBBBBBB", color: "b", outcome: "draw", timeControl: "rapid_5_0", source: "lichess" });
  });
  it("adresse et pseudo", () => {
    expect(lichessGamesUrl("https://lichess.org", "LeBaronRouge", 300, ["blitz", "rapid"]))
      .toBe("https://lichess.org/api/games/user/LeBaronRouge?max=300&perfType=blitz%2Crapid&moves=true&tags=true&clocks=false&evals=false&opening=true&literate=false");
    expect(lichessGamesUrl("http://x", "a1", 99999, ["blitz"])).toContain("max=500");
    expect(validLichessName("LeBaronRouge")).toBe(true);
    expect(validLichessName("../etc")).toBe(false);
    expect(validLichessName("a")).toBe(false);
  });
  it("service : import en arrière-plan, un à la fois, puis une minute d'attente", async () => {
    let t = 0; const saved: ImportedGame[] = []; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const svc = new ImportService({
      now: () => t, lichess: "http://li.test",
      fetchText: async (u) => { await gate; return u.includes("/Inconnu?") ? null : NDJSON; },
      save: async (_u, g) => { const before = saved.length; for (const x of g) if (!saved.some((y) => y.extId === x.extId)) saved.push(x); return saved.length - before; },
    });
    const s = svc.start("u1", "LeBaronRouge", 300, ["blitz", "rapid"]);
    expect(s).toMatchObject({ state: "running", account: "LeBaronRouge" });
    expect(svc.start("u1", "LeBaronRouge", 300, ["blitz"])).toBe("BUSY");
    release(); await new Promise((r) => setTimeout(r, 10));
    expect(svc.status("u1")).toMatchObject({ state: "done", found: 3, added: 3 });
    expect(svc.start("u1", "LeBaronRouge", 300, ["blitz"])).toBe("TOO_SOON");
    t += 61_000;
    svc.start("u1", "LeBaronRouge", 300, ["blitz"]); await new Promise((r) => setTimeout(r, 10));
    expect(svc.status("u1")).toMatchObject({ state: "done", found: 3, added: 0 }); // pas de doublon
    svc.start("u2", "Inconnu", 100, ["blitz"]); await new Promise((r) => setTimeout(r, 10));
    expect(svc.status("u2")).toMatchObject({ state: "error", error: "NOT_FOUND" });
  });
});
