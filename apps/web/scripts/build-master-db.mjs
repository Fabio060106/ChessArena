// Prépare la base de parties de maîtres à partir d'un ou plusieurs fichiers PGN (export ChessBase, TWIC, Lichess Elite…).
// Usage : npx tsx scripts/build-master-db.mjs fichier.pgn [autre.pgn…] [--min-elo 2200] [--max-ply 24] [--min-games 5] [--models 6] [--out public/master] [--source "texte"]
// Produit public/master/meta.json, s/<00..ff>.json (statistiques par position) et models/<répertoire>.json (parties modèles).
// Seuls les coups, joueurs, Elo, année, tournoi et résultat sont lus : les commentaires et variantes des fichiers sont ignorés.
import { createReadStream, mkdirSync, openSync, readSync, closeSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { Chess } from "chess.js";
import { splitPgnGames } from "@chessarena/shared";
import { REPERTOIRES } from "../lib/repertoireBook.ts";
import { MasterBuilder } from "../lib/masterDb.ts";
import { epdOf } from "../lib/openingBook.ts";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const minElo = Number(opt("--min-elo", "2200"));
const maxPly = Number(opt("--max-ply", "24"));
const minGames = Number(opt("--min-games", "5"));
const models = Number(opt("--models", "6"));
const out = opt("--out", new URL("../public/master", import.meta.url).pathname);
const source = opt("--source", "Base de parties de maîtres");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) { console.error("Usage : npx tsx scripts/build-master-db.mjs fichier.pgn [--min-elo 2200] [--max-ply 24] [--min-games 5]"); process.exit(1); }

// cibles des parties modèles : la fin de chaque ligne de répertoire, et quelques coups avant (si la fin exacte est rare)
const targets = [];
for (const r of REPERTOIRES) for (const l of r.lines) {
  const c = new Chess();
  const fens = [];
  for (const san of l.moves.split(" ")) { c.move(san); fens.push(epdOf(c.fen())); }
  targets.push({ rep: r.id, line: l.name, epd: fens.at(-1), ply: fens.length });
  if (fens.length >= 14) targets.push({ rep: r.id, line: l.name, epd: fens[fens.length - 7], ply: fens.length - 6 });
}
const b = new MasterBuilder({ minElo, maxPly, minGames, models, targets, maxEntries: 6_000_000 });

/** UTF-8 si le début du fichier est de l'UTF-8 valide, sinon Windows-1252 (latin1 : les exports ChessBase anciens). */
function encodingOf(path) {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(1 << 20);
  const n = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, Math.max(0, n - 4))); return "utf8"; } catch { return "latin1"; }
}

let read = 0, kept = 0;
const t0 = Date.now();
for (const f of files) {
  const enc = encodingOf(f);
  const size = statSync(f).size;
  let lines = [], inMoves = false, bytes = 0;
  const flush = () => {
    if (!lines.length) return;
    for (const g of splitPgnGames(lines.join("\n"))) { read++; if (b.add(g)) kept++; }
    lines = []; inMoves = false;
    if (read % 20000 === 0) process.stdout.write(`\r${f} : ${Math.round((100 * bytes) / size)} % · ${read} parties lues, ${kept} gardées · ${Math.round((Date.now() - t0) / 1000)} s   `);
  };
  const rl = createInterface({ input: createReadStream(f, { encoding: enc }), crlfDelay: Infinity });
  for await (const line of rl) {
    bytes += line.length + 1;
    const isTag = line.startsWith("[");
    if (isTag && inMoves) flush();
    if (!isTag && line.trim()) inMoves = true;
    lines.push(line);
  }
  flush();
}
process.stdout.write("\n");

const result = b.finish(source);
rmSync(out, { recursive: true, force: true });
let total = 0;
for (const [p, v] of result) {
  const file = join(out, p);
  mkdirSync(dirname(file), { recursive: true });
  const s = JSON.stringify(v);
  writeFileSync(file, s);
  total += s.length;
}
const meta = result.get("meta.json");
const lines = [...result.keys()].filter((k) => k.startsWith("models/")).reduce((s, k) => s + Object.keys(result.get(k)).length, 0);
console.log(`${read} parties lues, ${meta.games} gardées (Elo ≥ ${minElo} quand il est connu) · ${meta.positions} positions · parties modèles pour ${lines} lignes de répertoire · ${(total / 1e6).toFixed(1)} Mo dans ${out}`);
