// Vérifie les répertoires avec Stockfish : aucun coup du joueur ne doit perdre plus de 0,9 pion,
// et la position de fin de ligne doit rester jouable (au pire −1,2 pour le joueur, comme certaines lignes principales selon Stockfish).
// Usage : npx tsx scripts/check-repertoires.mjs
import { spawn } from "node:child_process";
import { Chess } from "chess.js";
import { REPERTOIRES } from "../lib/repertoireBook.ts";
import { COURSES } from "../lib/openingCourses.ts";

const sf = spawn("node", [new URL("../../../node_modules/stockfish/bin/stockfish-19-lite-single.js", import.meta.url).pathname]);
let buf = ""; let waiter = null;
sf.stdout.on("data", (d) => { buf += d; if (waiter && buf.includes("bestmove")) { const b = buf; buf = ""; const w = waiter; waiter = null; w(b); } });
const send = (s) => sf.stdin.write(s + "\n");
send("uci"); send("setoption name Hash value 64"); send("isready");
const cache = new Map();
async function evalFen(fen, depth = 12) {
  if (cache.has(fen)) return cache.get(fen);
  const out = await new Promise((res) => { waiter = res; send(`position fen ${fen}`); send(`go depth ${depth}`); });
  const lines = out.split("\n").filter((l) => l.includes(" score "));
  const last = lines.at(-1) ?? "";
  const m = last.match(/score (cp|mate) (-?\d+)/);
  let cp = m ? (m[1] === "cp" ? Number(m[2]) : (Number(m[2]) > 0 ? 10000 : -10000)) : 0;
  // point de vue des Blancs
  if (fen.split(" ")[1] === "b") cp = -cp;
  const best = out.match(/bestmove (\S+)/)?.[1];
  const r = { cp, best };
  cache.set(fen, r);
  return r;
}
const problems = [];
let n = 0;
for (const r of REPERTOIRES) for (const l of r.lines) {
  const c = new Chess();
  const sign = r.side === "w" ? 1 : -1;
  for (const s of l.moves.split(" ")) {
    const before = c.fen();
    const mover = c.turn();
    c.move(s);
    if (mover !== r.side) continue;
    const a = await evalFen(before), b = await evalFen(c.fen());
    const loss = sign * (a.cp - b.cp);
    // un gambit assume une petite perte théorique (Gambit du roi, Evans)
    if (loss > (r.id === "kgambit" || r.id === "evans" ? 130 : 90)) problems.push(`${r.id} / ${l.name} : ${c.history().length}. ${s} perd ${(loss / 100).toFixed(1)} (Stockfish : ${a.best})`);
  }
  const end = await evalFen(c.fen(), 14);
  if (sign * end.cp < -120) problems.push(`${r.id} / ${l.name} : fin de ligne à ${(sign * end.cp / 100).toFixed(1)} pour le joueur`);
  n++;
  process.stderr.write(`\r${n} lignes`);
}
// pièges : la position finale doit être nettement gagnante (≥ +2) pour le camp qui en profite
const seen = new Set();
for (const [id, c] of Object.entries(COURSES)) for (const t of c.traps) {
  if (seen.has(t.name)) continue; seen.add(t.name);
  const b = new Chess();
  for (const s of t.moves.split(" ")) b.move(s);
  const sign = t.winner === "w" ? 1 : -1;
  const e = b.isCheckmate() ? { cp: (b.turn() === "w" ? -1 : 1) * 10000 } : await evalFen(b.fen(), 14);
  if (sign * e.cp < 200) problems.push(`piège « ${t.name} » (${id}) : seulement ${(sign * e.cp / 100).toFixed(1)} pour le camp gagnant`);
}
console.log(`\n${n} lignes et ${seen.size} pièges vérifiés, ${problems.length} problème(s)`);
for (const p of problems) console.log(" -", p);
sf.kill();
