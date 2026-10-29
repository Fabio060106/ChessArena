import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AnalysisRequest, PlayerAnalysis } from "@chessarena/shared";
import { evaluatePlayer, slidingHoldFlags, type GameStat, type RuleConfig } from "../rules.js";
import { moveTimesFromClocks, readLichessGames, speedOf, toPgn, type LichessGame } from "./lichessPgn.js";
import { clopperPearsonUpper, trialsNeededForZero } from "./stats.js";
import type { Readable } from "node:stream";

/**
 * Calibration du taux de faux positifs de la règle WITHDRAWAL_HOLD sur des parties
 * humaines réelles (base ouverte Lichess).
 *
 * UNITÉ STATISTIQUE = LE JOUEUR, pas la partie : la règle porte sur des fenêtres de
 * 3 parties consécutives d'un même joueur, et ses fenêtres successives sont corrélées.
 * Le faux positif opérationnel est « un joueur honnête déclenche au moins une fois
 * sur son historique échantillonné ». On rapporte aussi le taux par fenêtre.
 *
 * Échantillonnage : on suit des joueurs (« sujets ») par tranche d'Elo et on garde
 * TOUTES leurs parties successives éligibles du flux (le dump est chronologique) —
 * c'est exactement ce que verra la règle en production.
 *
 * Biais à connaître : le dump contient des tricheurs non encore détectés. Les joueurs
 * déclenchés sont donc soit de vrais faux positifs, soit de vrais tricheurs ; l'option
 * `excludeUsers` (comptes fermés pour violation des CGU Lichess) retire les seconds.
 * Sans cette vérification, le taux mesuré SURESTIME les faux positifs (conservateur).
 */
export interface CalibrationOptions {
  totalGames: number;
  bands: Array<[number, number]>;
  gamesPerSubject: number;
  speeds: string[];
  rules: RuleConfig;
  openingPlies: number;
  concurrency: number;
  depth: number;
  checkpointPath?: string;
  /** limite de parties lues dans le flux (sécurité) */
  maxScan?: number;
  log?: (msg: string) => void;
}

export type GameAnalyser = (req: AnalysisRequest, depth: number) => Promise<PlayerAnalysis[]>;

interface Subject {
  user: string;
  band: number;
  games: string[];
}

interface SampledGame {
  id: string;
  req: AnalysisRequest;
  date: string;
}

export interface BandResult {
  band: string;
  subjects: number;
  evaluatedPlayers: number;
  windows: number;
  flaggedWindows: number;
  flaggedPlayers: string[];
  playerFpr: number;
  playerFprUpper95: number;
  windowFpr: number;
  windowFprUpper95: number;
  acplPercentiles: Record<string, number>;
  matchPercentiles: Record<string, number>;
}

export interface CalibrationReport {
  generatedAt: string;
  rules: RuleConfig;
  depth: number;
  scanned: number;
  sampledGames: number;
  analysedGames: number;
  bands: BandResult[];
  overall: Omit<BandResult, "band" | "acplPercentiles" | "matchPercentiles">;
  target: number;
  validated: boolean;
  playersNeededForZero: number;
  sweep: Array<{ acplMax: number; matchMin: number; flaggedPlayers: number; players: number; upper95: number; passes: boolean }>;
}

const EXCLUDED_TERMINATIONS = new Set(["Rules infraction", "Abandoned", "Unterminated"]);

export function eligibleLichessGame(g: LichessGame, speeds: string[], minPlies: number): boolean {
  const h = g.headers;
  if (!h.Event?.includes("Rated")) return false;
  if (h.Variant && h.Variant !== "Standard") return false;
  if (EXCLUDED_TERMINATIONS.has(h.Termination ?? "")) return false;
  if (!speeds.includes(speedOf(h.TimeControl ?? "-"))) return false;
  if (!h.White || !h.Black || !Number(h.WhiteElo) || !Number(h.BlackElo)) return false;
  // une partie trop courte ne peut pas fournir 15 coups retenus par camp : elle serait
  // ignorée par la règle, inutile de l'analyser (n'affecte pas la consécutivité)
  return g.sans.length >= minPlies && g.clocks.some((c) => c !== null);
}

export function toRequest(g: LichessGame): AnalysisRequest {
  const id = (g.headers.Site ?? "").split("/").pop() || `${g.headers.White}-${g.headers.Black}-${g.headers.UTCDate}-${g.headers.UTCTime}`;
  return {
    gameId: id,
    pgn: toPgn(g),
    timeControl: "blitz_3_0", // indicatif : non utilisé par l'analyse
    currency: "PLAY",
    moveTimesMs: moveTimesFromClocks(g.clocks, g.headers.TimeControl ?? "0+0"),
    focusLoss: { w: 0, b: 0 },
    players: {
      w: { userId: g.headers.White!, rating: Number(g.headers.WhiteElo) },
      b: { userId: g.headers.Black!, rating: Number(g.headers.BlackElo) },
    },
    endedAt: `${(g.headers.UTCDate ?? "").replace(/\./g, "-")}T${g.headers.UTCTime ?? "00:00:00"}Z`,
  };
}

/** Phase 1 — échantillonnage en flux. */
export async function sampleGames(input: Readable, o: CalibrationOptions) {
  const quota = Math.ceil(o.totalGames / o.bands.length);
  const slots = o.bands.map(() => 0);
  const subjects = new Map<string, Subject>();
  const retired = new Set<string>();
  const games = new Map<string, SampledGame>();
  const minPlies = o.openingPlies + 2 * o.rules.minAnalysedMoves;
  let scanned = 0;
  const bandOf = (elo: number) => o.bands.findIndex(([lo, hi]) => elo >= lo && elo < hi);

  for await (const g of readLichessGames(input)) {
    scanned++;
    if (o.maxScan && scanned > o.maxScan) break;
    if (scanned % 1_000_000 === 0) o.log?.(`  ${scanned.toLocaleString("fr-FR")} parties lues, ${games.size} retenues`);
    if (!eligibleLichessGame(g, o.speeds, minPlies)) continue;
    const req = toRequest(g);
    let attached = false;
    for (const color of ["w", "b"] as const) {
      const user = req.players[color].userId;
      if (retired.has(user)) continue;
      let s = subjects.get(user);
      if (!s) {
        const b = bandOf(req.players[color].rating);
        if (b < 0 || slots[b]! >= quota) continue;
        s = { user, band: b, games: [] };
        subjects.set(user, s);
      }
      if (s.games.length >= o.gamesPerSubject) continue;
      s.games.push(req.gameId);
      slots[s.band]!++;
      attached = true;
      if (s.games.length >= o.gamesPerSubject) retired.add(user);
    }
    if (attached) games.set(req.gameId, { id: req.gameId, req, date: req.endedAt! });
    if (slots.every((x) => x >= quota) && [...subjects.values()].every((s) => s.games.length >= o.gamesPerSubject || s.games.length === 0)) break;
  }
  return { scanned, games, subjects: [...subjects.values()] };
}

/** Phase 2 — analyse moteur, parallèle, avec point de reprise (JSONL). */
export async function analyseSample(
  games: Map<string, SampledGame>, analyse: GameAnalyser, o: CalibrationOptions,
): Promise<Map<string, PlayerAnalysis[]>> {
  const done = new Map<string, PlayerAnalysis[]>();
  if (o.checkpointPath && existsSync(o.checkpointPath)) {
    for (const line of readFileSync(o.checkpointPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { gameId: string; depth: number; players: PlayerAnalysis[] };
      if (r.depth === o.depth) done.set(r.gameId, r.players);
    }
    o.log?.(`  reprise : ${done.size} parties déjà analysées`);
  }
  const todo = [...games.values()].filter((g) => !done.has(g.id));
  const t0 = Date.now();
  let next = 0;
  let finished = 0;
  const workers = Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    while (next < todo.length) {
      const g = todo[next++]!;
      try {
        const players = await analyse(g.req, o.depth);
        done.set(g.id, players);
        if (o.checkpointPath) appendFileSync(o.checkpointPath, JSON.stringify({ gameId: g.id, depth: o.depth, players }) + "\n");
      } catch (e) {
        o.log?.(`  ⚠ ${g.id} : ${(e as Error).message}`);
      }
      if (++finished % 200 === 0 || finished === todo.length) {
        const rate = finished / ((Date.now() - t0) / 1000);
        o.log?.(`  ${finished}/${todo.length} analysées — ${rate.toFixed(2)} parties/s — reste ~${Math.round((todo.length - finished) / rate / 60)} min`);
      }
    }
  });
  await Promise.all(workers);
  return done;
}

function percentiles(xs: number[], ps = [1, 5, 25, 50]): Record<string, number> {
  const s = [...xs].sort((a, b) => a - b);
  return Object.fromEntries(ps.map((p) => [`p${p}`, s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 1000) / 1000 : NaN]));
}

/** Historique chronologique d'un sujet, sous forme de GameStat. */
function historyOf(s: Subject, games: Map<string, SampledGame>, analyses: Map<string, PlayerAnalysis[]>): GameStat[] {
  const out: GameStat[] = [];
  for (const id of s.games) {
    const p = analyses.get(id)?.find((x) => x.userId === s.user);
    const g = games.get(id);
    if (!p || !g) continue;
    out.push({ gameId: id, endedAt: g.date, depth: Infinity, rating: p.rating, analysedMoves: p.analysedMoves, acpl: p.acpl, engineMatchRate: p.engineMatchRate, timeCv: p.timeCv, focusLoss: 0 });
  }
  return out.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

/** Phase 3 — taux de faux positifs, par tranche et global, + balayage des seuils. */
export function computeReport(
  subjects: Subject[], games: Map<string, SampledGame>, analyses: Map<string, PlayerAnalysis[]>,
  o: CalibrationOptions, extra: { scanned: number; excludeUsers?: Set<string> },
): CalibrationReport {
  const target = 0.001;
  const keep = subjects.filter((s) => !extra.excludeUsers?.has(s.user));
  const histories = new Map(keep.map((s) => [s.user, historyOf(s, games, analyses)]));

  const evalBand = (members: Subject[], rules: RuleConfig) => {
    let evaluated = 0;
    let windows = 0;
    let flaggedWindows = 0;
    const flagged: string[] = [];
    const acpls: number[] = [];
    const matches: number[] = [];
    for (const s of members) {
      const h = histories.get(s.user)!;
      const flags = slidingHoldFlags(h, rules);
      if (flags.length === 0) continue;
      evaluated++;
      windows += flags.length;
      flaggedWindows += flags.filter(Boolean).length;
      if (flags.some(Boolean)) flagged.push(s.user);
      for (const g of h.filter((x) => x.analysedMoves >= rules.minAnalysedMoves)) { acpls.push(g.acpl); matches.push(g.engineMatchRate); }
    }
    return {
      subjects: members.length, evaluatedPlayers: evaluated, windows, flaggedWindows, flaggedPlayers: flagged,
      playerFpr: evaluated ? flagged.length / evaluated : 0,
      playerFprUpper95: clopperPearsonUpper(flagged.length, evaluated),
      windowFpr: windows ? flaggedWindows / windows : 0,
      windowFprUpper95: clopperPearsonUpper(flaggedWindows, windows),
      acplPercentiles: percentiles(acpls),
      matchPercentiles: percentiles(matches, [50, 75, 95, 99]),
    };
  };

  const bands = o.bands.map(([lo, hi], i) => ({ band: `${lo}–${hi}`, ...evalBand(keep.filter((s) => s.band === i), o.rules) }));
  const { acplPercentiles: _a, matchPercentiles: _m, ...overall } = evalBand(keep, o.rules);

  const sweep = [];
  for (const acplMax of [6, 8, 10, 12, 15, 20]) {
    for (const matchMin of [0.7, 0.75, 0.8, 0.85, 0.9]) {
      const r = evalBand(keep, { ...o.rules, acplMax, matchMin });
      sweep.push({ acplMax, matchMin, flaggedPlayers: r.flaggedPlayers.length, players: r.evaluatedPlayers, upper95: r.playerFprUpper95, passes: r.playerFprUpper95 < target });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rules: o.rules,
    depth: o.depth,
    scanned: extra.scanned,
    sampledGames: games.size,
    analysedGames: analyses.size,
    bands,
    overall,
    target,
    validated: overall.playerFprUpper95 < target,
    playersNeededForZero: trialsNeededForZero(target),
    sweep,
  };
}

export function reportMarkdown(r: CalibrationReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(3)} %`;
  const lines = [
    `# Calibration anti-triche — ${r.generatedAt.slice(0, 10)}`,
    "",
    `Règle : ACPL < ${r.rules.acplMax} sur ${r.rules.window} parties consécutives, coïncidence moteur poolée ≥ ${r.rules.matchMin * 100} %, Elo < ${r.rules.ratingCeiling}, ≥ ${r.rules.minAnalysedMoves} coups retenus par partie. Profondeur d'analyse : ${r.depth}.`,
    "",
    `Parties lues : ${r.scanned.toLocaleString("fr-FR")} · échantillonnées : ${r.sampledGames.toLocaleString("fr-FR")} · analysées : ${r.analysedGames.toLocaleString("fr-FR")}`,
    "",
    `**Objectif : faux positifs < ${pct(r.target)} (borne supérieure Clopper-Pearson 95 %, par joueur).** Avec 0 déclenchement, il faut ≥ ${r.playersNeededForZero.toLocaleString("fr-FR")} joueurs évalués pour le démontrer.`,
    "",
    `**Résultat global : ${r.validated ? "✅ VALIDÉ" : "❌ NON VALIDÉ"}** — ${r.overall.flaggedPlayers.length} joueur(s) déclenché(s) sur ${r.overall.evaluatedPlayers.toLocaleString("fr-FR")} (observé ${pct(r.overall.playerFpr)}, borne 95 % ${pct(r.overall.playerFprUpper95)}) · fenêtres : ${r.overall.flaggedWindows}/${r.overall.windows} (borne ${pct(r.overall.windowFprUpper95)})`,
    "",
    "| Tranche Elo | Joueurs évalués | Déclenchés | FP observé | Borne 95 % | Fenêtres | ACPL p1 / p5 / p50 | Coïncidence p50 / p95 / p99 |",
    "|---|---|---|---|---|---|---|---|",
    ...r.bands.map((b) => `| ${b.band} | ${b.evaluatedPlayers} | ${b.flaggedPlayers.length} | ${pct(b.playerFpr)} | ${pct(b.playerFprUpper95)}${b.playerFprUpper95 < r.target ? " ✅" : ""} | ${b.flaggedWindows}/${b.windows} | ${b.acplPercentiles.p1} / ${b.acplPercentiles.p5} / ${b.acplPercentiles.p50} | ${b.matchPercentiles.p50} / ${b.matchPercentiles.p95} / ${b.matchPercentiles.p99} |`),
    "",
    "## Balayage des seuils (global, par joueur)",
    "",
    "| ACPL < | Coïncidence ≥ | Déclenchés | Borne 95 % | < 0,1 % |",
    "|---|---|---|---|---|",
    ...r.sweep.map((s) => `| ${s.acplMax} | ${(s.matchMin * 100).toFixed(0)} % | ${s.flaggedPlayers}/${s.players} | ${pct(s.upper95)} | ${s.passes ? "✅" : "—"} |`),
    "",
    "## Joueurs déclenchés (à vérifier : tricheurs Lichess ou vrais faux positifs ?)",
    "",
    ...(r.overall.flaggedPlayers.length ? r.overall.flaggedPlayers.map((u) => `- https://lichess.org/@/${u}`) : ["_aucun_"]),
    "",
  ];
  return lines.join("\n");
}

export { evaluatePlayer };
