import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { Chess } from "chess.js";
import type { PlayerAnalysis } from "@chessarena/shared";
import { moveTimesFromClocks, parseMovetext, readLichessGames, speedOf, toPgn, type LichessGame } from "../src/calibration/lichessPgn.js";
import { binomCdf, clopperPearsonUpper, trialsNeededForZero } from "../src/calibration/stats.js";
import { analyseSample, computeReport, reportMarkdown, sampleGames, type CalibrationOptions } from "../src/calibration/run.js";
import { DEFAULT_RULES } from "../src/rules.js";

const LICHESS_SAMPLE = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abcd1234"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[UTCDate "2026.09.01"]
[UTCTime "10:00:00"]
[WhiteElo "1510"]
[BlackElo "1490"]
[TimeControl "180+2"]
[Termination "Normal"]

1. e4 { [%eval 0.18] [%clk 0:03:00] } 1... c5 { [%eval 0.25] [%clk 0:03:00] } 2. Nf3 { [%clk 0:02:58] } 2... d6?! { [%clk 0:02:55] } 3. d4 $1 { [%clk 0:02:59] } 3... cxd4 { [%clk 0:02:50] } 1-0

`;

describe("lecture des exports Lichess", () => {
  it("SAN, horloges, annotations ignorées", async () => {
    const games: LichessGame[] = [];
    for await (const g of readLichessGames(Readable.from(LICHESS_SAMPLE))) games.push(g);
    expect(games).toHaveLength(1);
    expect(games[0]!.headers).toMatchObject({ White: "alice", WhiteElo: "1510", TimeControl: "180+2" });
    expect(games[0]!.sans).toEqual(["e4", "c5", "Nf3", "d6", "d4", "cxd4"]);
    expect(games[0]!.clocks).toEqual([180, 180, 178, 175, 179, 170]);
    expect(toPgn(games[0]!)).toBe("1. e4 c5 2. Nf3 d6 3. d4 cxd4 *");
    expect(() => new Chess().loadPgn(toPgn(games[0]!))).not.toThrow();
  });

  it("temps de réflexion = horloge précédente − horloge + incrément (2 premiers demi-coups non chronométrés)", () => {
    expect(moveTimesFromClocks([180, 180, 178, 175, 179, 170], "180+2")).toEqual([0, 0, 4000, 7000, 1000, 7000]);
    expect(moveTimesFromClocks([60, 60, null, 55], "60+0")).toEqual([0, 0, 0, 5000]);
  });

  it("catégories de cadence Lichess", () => {
    expect(speedOf("60+0")).toBe("bullet");
    expect(speedOf("180+2")).toBe("blitz");
    expect(speedOf("600+0")).toBe("rapid");
    expect(speedOf("15+0")).toBe("ultrabullet");
    expect(speedOf("-")).toBe("correspondence");
  });

  it("variantes ignorées, commentaires multilignes tolérés", () => {
    const r = parseMovetext("1. e4 (1. d4 d5) 1... e5 { un\ncommentaire [%clk 0:01:00] } 2. Nf3 *");
    expect(r.sans).toEqual(["e4", "e5", "Nf3"]);
    expect(r.clocks).toEqual([null, 60, null]);
  });
});

describe("statistiques de validation", () => {
  it("Clopper-Pearson unilatéral 95 %", () => {
    expect(clopperPearsonUpper(0, 2995)).toBeLessThan(0.001);
    expect(clopperPearsonUpper(0, 2994)).toBeGreaterThan(0.001);
    expect(clopperPearsonUpper(1, 100)).toBeCloseTo(0.0466, 3);
    expect(clopperPearsonUpper(5, 1000)).toBeCloseTo(0.01048, 4);
    expect(trialsNeededForZero(0.001)).toBe(2995);
    expect(binomCdf(2, 10, 0.5)).toBeCloseTo(0.0546875, 10);
  });
});

/** Génère un export « façon Lichess » : parties légales de 60 demi-coups, horloges, joueurs récurrents. */
function synthDump(spec: Array<{ w: string; b: string; we: number; be: number; tc?: string; term?: string; event?: string }>): string {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return spec.map((s, i) => {
    const c = new Chess();
    const parts: string[] = [];
    let clk = [180, 180];
    while (c.history().length < 60 && !c.isGameOver()) {
      const ms = c.moves();
      const san = ms[Math.floor(rnd() * ms.length)]!;
      const ply = c.history().length;
      c.move(san);
      clk[ply % 2]! -= ply < 2 ? 0 : 1 + Math.floor(rnd() * 4);
      parts.push(`${ply % 2 === 0 ? `${ply / 2 + 1}. ` : `${Math.floor(ply / 2) + 1}... `}${san} { [%clk 0:0${Math.floor(clk[ply % 2]! / 60)}:${String(clk[ply % 2]! % 60).padStart(2, "0")}] }`);
    }
    return `[Event "${s.event ?? "Rated Blitz game"}"]\n[Site "https://lichess.org/g${String(i).padStart(6, "0")}"]\n[White "${s.w}"]\n[Black "${s.b}"]\n[Result "*"]\n[UTCDate "2026.09.01"]\n[UTCTime "10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}"]\n[WhiteElo "${s.we}"]\n[BlackElo "${s.be}"]\n[TimeControl "${s.tc ?? "180+0"}"]\n[Termination "${s.term ?? "Normal"}"]\n\n${parts.join(" ")} *\n`;
  }).join("\n");
}

const baseOpts = (o: Partial<CalibrationOptions> = {}): CalibrationOptions => ({
  totalGames: 1000, bands: [[1200, 1600], [1600, 2000]], gamesPerSubject: 5, speeds: ["blitz"], rules: DEFAULT_RULES,
  openingPlies: 16, concurrency: 4, depth: 12, ...o,
});

describe("échantillonnage et rapport de calibration", () => {
  it("suit des joueurs par tranche, garde leurs parties consécutives, filtre les parties inéligibles", async () => {
    const spec = [];
    for (let i = 0; i < 6; i++) spec.push({ w: "low1", b: `x${i}`, we: 1300, be: 2400 });
    spec.push({ w: "low1", b: "y", we: 1300, be: 1300, term: "Rules infraction" }); // exclue (triche Lichess)
    spec.push({ w: "low1", b: "y", we: 1300, be: 1300, tc: "60+0" });               // bullet : exclue
    for (let i = 0; i < 3; i++) spec.push({ w: "mid1", b: `z${i}`, we: 1700, be: 2500 });
    const { games, subjects } = await sampleGames(Readable.from(synthDump(spec)), baseOpts());
    const low = subjects.find((s) => s.user === "low1")!;
    expect(low.band).toBe(0);
    expect(low.games).toHaveLength(5); // plafonné à gamesPerSubject
    expect(subjects.find((s) => s.user === "mid1")!.games).toHaveLength(3);
    expect(subjects.some((s) => s.user.startsWith("x"))).toBe(false); // 2400 : hors tranches
    expect(games.size).toBe(8);
  });

  it("de bout en bout : un tricheur simulé est déclenché, les honnêtes non ; reprise depuis le point de contrôle", async () => {
    const spec = [];
    for (let i = 0; i < 4; i++) spec.push({ w: "cheaty", b: `h${i}`, we: 1500, be: 2600 });
    for (const u of ["hon1", "hon2", "hon3"]) for (let i = 0; i < 4; i++) spec.push({ w: u, b: `o${u}${i}`, we: 1700, be: 2600 });
    const opts = baseOpts({ checkpointPath: `${process.env.TMPDIR ?? "/tmp"}/calib-${Date.now()}.jsonl` });
    const { games, subjects, scanned } = await sampleGames(Readable.from(synthDump(spec)), opts);
    let calls = 0;
    const fake = async (req: { players: { w: { userId: string; rating: number }; b: { userId: string; rating: number } } }): Promise<PlayerAnalysis[]> => {
      calls++;
      return (["w", "b"] as const).map((color) => {
        const u = req.players[color].userId;
        const cheat = u === "cheaty";
        return { userId: u, color, rating: req.players[color].rating, analysedMoves: 20, acpl: cheat ? 5 : 45, engineMatchRate: cheat ? 0.9 : 0.5, timeMeanMs: 3000, timeVariance: 1, timeCv: 0.5, focusLoss: 0 };
      });
    };
    const analyses = await analyseSample(games, fake as never, opts);
    const n = games.size; // les parties aléatoires terminées trop tôt (< 46 demi-coups) ont été écartées
    expect(n).toBeGreaterThanOrEqual(14);
    expect(calls).toBe(n);
    const again = await analyseSample(games, fake as never, opts); // reprise : rien à refaire
    expect(calls).toBe(n);
    expect(again.size).toBe(n);

    const r = computeReport(subjects, games, analyses, opts, { scanned });
    expect(r.overall.flaggedPlayers).toEqual(["cheaty"]);
    expect(r.overall.evaluatedPlayers).toBeGreaterThanOrEqual(3);
    expect(r.bands[0]!.flaggedPlayers).toEqual(["cheaty"]);
    expect(r.bands[1]!.flaggedPlayers).toEqual([]);
    expect(r.validated).toBe(false); // 4 joueurs ne prouvent rien : la borne reste haute
    // exclusion des tricheurs avérés (vérification CGU Lichess)
    const clean = computeReport(subjects, games, analyses, opts, { scanned, excludeUsers: new Set(["cheaty"]) });
    expect(clean.overall.flaggedPlayers).toEqual([]);
    expect(clean.overall.playerFprUpper95).toBeGreaterThan(0.001); // toujours trop peu de joueurs
    const md = reportMarkdown(r);
    expect(md).toContain("NON VALIDÉ");
    expect(md).toContain("https://lichess.org/@/cheaty");
    expect(r.sweep.length).toBe(30);
  });
});
