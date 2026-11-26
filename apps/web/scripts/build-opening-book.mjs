// Construit public/opening-book.json à partir de la base libre (CC0) lichess-org/chess-openings :
// une entrée par position nommée : [EPD, ECO, nom, nombre de demi-coups de la ligne de référence].
// Usage : node scripts/build-opening-book.mjs <dossier chess-openings>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";

const dir = process.argv[2];
const byEpd = new Map();
let n = 0;
for (const f of ["a", "b", "c", "d", "e"]) {
  const rows = readFileSync(join(dir, `${f}.tsv`), "utf8").trim().split("\n").slice(1);
  for (const row of rows) {
    const [eco, name, pgn] = row.split("\t");
    const c = new Chess();
    const sans = pgn.replace(/\d+\.\s*/g, "").trim().split(/\s+/);
    for (const s of sans) c.move(s);
    const epd = c.fen().split(" ").slice(0, 4).join(" ");
    const prev = byEpd.get(epd);
    if (!prev || sans.length < prev[3]) byEpd.set(epd, [epd, eco, name, sans.length]);
    n++;
  }
}
const out = [...byEpd.values()];
writeFileSync(process.argv[3] ?? "public/opening-book.json", JSON.stringify(out));
console.log(`${n} lignes, ${out.length} positions nommées`);
