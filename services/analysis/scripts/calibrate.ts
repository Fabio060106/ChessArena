/**
 * Calibration des seuils anti-triche sur la base ouverte Lichess.
 *
 *   # 1. télécharger un export mensuel (≈ 30 Go compressé ; le flux suffit, pas besoin de décompresser)
 *   curl -O https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst
 *
 *   # 2. lancer (moteur natif recommandé : STOCKFISH_CMD=stockfish)
 *   npm run calibrate -w @chessarena/analysis -- \
 *     --input lichess_db_standard_rated_2026-09.pgn.zst --games 50000 --depth 18 \
 *     --bands 1200-1400,1400-1600,1600-1800,1800-2000,2000-2200 --speeds blitz,rapid \
 *     --per-subject 5 --out calibration/2026-09
 *
 *   # 3. (recommandé) exclure les comptes Lichess fermés pour violation des CGU, puis recalculer
 *   … --tos-check
 *
 * Coût indicatif (Stockfish natif, 1 thread) : ~0,1–0,2 s par position à profondeur 18,
 * ~60 positions par partie → 50 000 parties ≈ 80–170 h CPU (3–6 h sur 32 cœurs).
 * Reprise automatique depuis `<out>.checkpoint.jsonl` en cas d'interruption.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { EnginePool } from "../src/uci.js";
import { analyseGame, DEFAULT_METRICS } from "../src/metrics.js";
import { DEFAULT_RULES } from "../src/rules.js";
import { openPgnStream } from "../src/calibration/lichessPgn.js";
import { analyseSample, computeReport, reportMarkdown, sampleGames, type CalibrationOptions } from "../src/calibration/run.js";

const { values: a } = parseArgs({
  options: {
    input: { type: "string" },
    games: { type: "string", default: "50000" },
    bands: { type: "string", default: "1200-1400,1400-1600,1600-1800,1800-2000,2000-2200" },
    speeds: { type: "string", default: "blitz,rapid" },
    "per-subject": { type: "string", default: "5" },
    depth: { type: "string", default: "18" },
    concurrency: { type: "string", default: String(availableParallelism()) },
    engine: { type: "string", default: process.env.STOCKFISH_CMD ?? "stockfish" },
    "max-scan": { type: "string" },
    out: { type: "string", default: "calibration/report" },
    "tos-check": { type: "boolean", default: false },
    "acpl-max": { type: "string" },
    "match-min": { type: "string" },
  },
});
if (!a.input) {
  console.error("usage : calibrate --input <fichier.pgn[.zst|.gz] | -> [--games 50000] [--depth 18] [--out chemin]");
  process.exit(2);
}

const opts: CalibrationOptions = {
  totalGames: Number(a.games),
  bands: a.bands!.split(",").map((b) => b.split("-").map(Number) as [number, number]),
  gamesPerSubject: Number(a["per-subject"]),
  speeds: a.speeds!.split(","),
  rules: {
    ...DEFAULT_RULES,
    ...(a["acpl-max"] ? { acplMax: Number(a["acpl-max"]) } : {}),
    ...(a["match-min"] ? { matchMin: Number(a["match-min"]) } : {}),
  },
  openingPlies: DEFAULT_METRICS.openingPlies,
  concurrency: Number(a.concurrency),
  depth: Number(a.depth),
  checkpointPath: `${a.out}.checkpoint.jsonl`,
  maxScan: a["max-scan"] ? Number(a["max-scan"]) : undefined,
  log: (m) => console.log(m),
};
mkdirSync(dirname(a.out!), { recursive: true });

console.log(`[1/3] Échantillonnage : ${opts.totalGames.toLocaleString("fr-FR")} parties, tranches ${a.bands}, ${opts.gamesPerSubject} parties consécutives par joueur`);
const { scanned, games, subjects } = await sampleGames(openPgnStream(a.input), opts);
console.log(`      ${games.size.toLocaleString("fr-FR")} parties retenues pour ${subjects.length.toLocaleString("fr-FR")} joueurs (${scanned.toLocaleString("fr-FR")} lues)`);

console.log(`[2/3] Analyse Stockfish profondeur ${opts.depth} sur ${opts.concurrency} processus (${a.engine})`);
const pool = new EnginePool({ command: a.engine!, size: opts.concurrency, threads: 1, hashMb: 64 });
await pool.init();
console.log(`      moteur : ${pool.name}`);
const analyses = await analyseSample(games, async (req, depth) => {
  return pool.use(async (e) => {
    await e.newGame();
    return (await analyseGame(req, (fen) => e.evaluate(fen, depth))).players;
  });
}, opts);
pool.close();

console.log("[3/3] Statistiques");
let report = computeReport(subjects, games, analyses, opts, { scanned });
if (a["tos-check"] && report.overall.flaggedPlayers.length) {
  // API publique Lichess : POST /api/users (≤ 300 identifiants), champ `tosViolation`
  const flagged = report.overall.flaggedPlayers;
  const violators = new Set<string>();
  for (let i = 0; i < flagged.length; i += 300) {
    const r = await fetch("https://lichess.org/api/users", { method: "POST", body: flagged.slice(i, i + 300).join(","), headers: { "content-type": "text/plain" } });
    for (const u of (await r.json()) as Array<{ id: string; username: string; tosViolation?: boolean; disabled?: boolean }>) {
      if (u.tosViolation) violators.add(u.username);
    }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  console.log(`      ${violators.size}/${flagged.length} joueurs déclenchés sont des tricheurs avérés sur Lichess (exclus du taux)`);
  report = computeReport(subjects, games, analyses, opts, { scanned, excludeUsers: violators });
}
writeFileSync(`${a.out}.json`, JSON.stringify(report, null, 2));
writeFileSync(`${a.out}.md`, reportMarkdown(report));
console.log(reportMarkdown(report).split("\n").slice(0, 16).join("\n"));
console.log(`\nRapport : ${a.out}.md / ${a.out}.json`);
process.exit(report.validated ? 0 : 1);
