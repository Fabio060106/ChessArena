// Détecteur d'« armes secrètes » : dans chaque position des répertoires, les coups rares (hors théorie, ou absents de la base
// de maîtres si elle est installée) que Stockfish juge presque aussi bons que le coup principal, puis leur valeur pratique :
// combien de réponses tiennent pour l'adversaire, quelles réponses naturelles sont des erreurs (pièges), et la suite à connaître.
// Même travail dans l'autre sens (« alertes ») : les surprises que l'adversaire peut jouer contre le répertoire, et l'antidote.
// Usage : npx tsx scripts/find-weapons.mjs [--depth 16] [--workers 2] [--only id,id] [--max-ply 18]
// Écrit public/weapons.json. Les analyses sont gardées dans scripts/.weapons-cache.json (relance = reprise).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";
import { REPERTOIRES } from "../lib/repertoireBook.ts";
import { OpeningBook, epdOf } from "../lib/openingBook.ts";
import { shardOf } from "../lib/masterDb.ts";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const DEPTH = Number(opt("--depth", "16"));
const WORKERS = Number(opt("--workers", "2"));
const MIN_PLY = Number(opt("--min-ply", "3"));
const MAX_PLY = Number(opt("--max-ply", "18"));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",")) : null;
const ROOT = new URL("..", import.meta.url).pathname;
const CACHE = `${ROOT}scripts/.weapons-cache.json`;
const OUT = `${ROOT}public/weapons.json`;

const book = new OpeningBook(JSON.parse(readFileSync(`${ROOT}public/opening-book.json`, "utf8")));
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
let dirty = 0;
const save = () => { writeFileSync(CACHE, JSON.stringify(cache)); dirty = 0; };

// base de maîtres (facultative) : fréquence de chaque coup
const MASTER = `${ROOT}public/master`;
const hasMaster = existsSync(`${MASTER}/meta.json`);
const shards = new Map();
function masterRows(fen) {
  if (!hasMaster) return null;
  const epd = epdOf(fen), sh = shardOf(epd);
  if (!shards.has(sh)) shards.set(sh, existsSync(`${MASTER}/s/${sh}.json`) ? JSON.parse(readFileSync(`${MASTER}/s/${sh}.json`, "utf8")) : {});
  return shards.get(sh)[epd] ?? [];
}

// ─── moteur ──────────────────────────────────────────────────────────────────
class Engine {
  constructor() {
    this.p = spawn("node", [`${ROOT}../../node_modules/stockfish/bin/stockfish-19-single.js`]);
    this.buf = ""; this.w = null;
    this.p.stdout.on("data", (d) => { this.buf += d; if (this.w && this.buf.includes("bestmove")) { const b = this.buf; this.buf = ""; const f = this.w; this.w = null; f(b); } });
    this.send("uci"); this.send("setoption name Hash value 256");
  }
  send(s) { this.p.stdin.write(s + "\n"); }
  /** MultiPV : [{ uci, cp (point de vue du camp au trait), pv }] du meilleur au moins bon */
  async run(fen, depth, multipv) {
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send("ucinewgame");
    const out = await new Promise((r) => { this.w = r; this.send(`position fen ${fen}`); this.send(`go depth ${depth}`); });
    const best = new Map();
    for (const l of out.split("\n")) {
      const m = / depth (\d+) .*multipv (\d+) score (cp|mate) (-?\d+).* pv (.+)$/.exec(l);
      if (!m || Number(m[1]) !== depth) continue;
      const cp = m[3] === "cp" ? Number(m[4]) : (Number(m[4]) > 0 ? 3000 - Number(m[4]) : -3000 - Number(m[4]));
      const pv = m[5].trim().split(" ");
      best.set(Number(m[2]), { uci: pv[0], cp, pv: pv.slice(0, 10) });
    }
    if (!best.size) { // repli : dernière profondeur disponible
      for (const l of out.split("\n")) {
        const m = / multipv (\d+) score (cp|mate) (-?\d+).* pv (.+)$/.exec(l);
        if (!m) continue;
        const cp = m[2] === "cp" ? Number(m[3]) : (Number(m[3]) > 0 ? 3000 - Number(m[3]) : -3000 - Number(m[3]));
        const pv = m[4].trim().split(" ");
        best.set(Number(m[1]), { uci: pv[0], cp, pv: pv.slice(0, 10) });
      }
    }
    return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
}
const engines = Array.from({ length: WORKERS }, () => new Engine());
const free = [...engines];
const waiting = [];
async function analyse(fen, depth, multipv) {
  const key = `${epdOf(fen)}|${depth}|${multipv}`;
  if (cache[key]) return cache[key];
  const e = free.pop() ?? await new Promise((r) => waiting.push(r));
  try {
    const r = await e.run(fen, depth, multipv);
    cache[key] = r;
    if (++dirty >= 20) save();
    return r;
  } finally {
    const next = waiting.shift();
    if (next) next(e); else free.push(e);
  }
}

// ─── outils ──────────────────────────────────────────────────────────────────
const sanOf = (fen, uci) => { const c = new Chess(fen); try { return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return null; } };
const play = (fen, uci) => { const c = new Chess(fen); c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); return c.fen(); };
const pvSan = (fen, pv, n = 8) => { const c = new Chess(fen); const out = []; for (const u of pv.slice(0, n)) { try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; } } return out; };

/** Rareté d'un coup : base de maîtres si installée, sinon livre d'ouvertures (position nommée ou non). */
function rarity(fen, uci) {
  const rows = masterRows(fen);
  if (rows) {
    const total = rows.reduce((s, r) => s + r[1], 0);
    const r = rows.find((x) => x[0] === uci);
    const n = r ? r[1] : 0;
    if (total >= 20 && n / total > 0.04) return null; // coup courant chez les maîtres
    return { kind: n === 0 ? "inédit" : "rare", masters: n, total };
  }
  const after = book.lookup(play(fen, uci));
  const branches = book.branches(fen);
  const named = branches.find((b) => b.uci === uci);
  if (!after && !named) return { kind: "hors-livre" };
  const main = book.mainBranches(fen);
  if (named && !main.some((b) => b.uci === uci)) return { kind: "rare", name: named.name };
  return null; // théorie connue
}

// ─── positions des répertoires ───────────────────────────────────────────────
// epd → { fen, ply, side (camp du répertoire), contexts: [{rep, line, prefix (SAN), repMoves: Set uci}] }
const positions = new Map();
for (const r of REPERTOIRES) {
  if (ONLY && !ONLY.has(r.id)) continue;
  for (const l of r.lines) {
    const c = new Chess();
    const sans = l.moves.split(" ");
    for (let i = 0; i < sans.length && i < MAX_PLY; i++) {
      const fen = c.fen();
      const m = c.move(sans[i]);
      if (i < MIN_PLY) continue;
      const k = `${epdOf(fen)}|${r.side}`;
      const p = positions.get(k) ?? { fen, ply: i, side: r.side, contexts: [], repMoves: new Set() };
      p.repMoves.add(m.from + m.to + (m.promotion ?? ""));
      if (!p.contexts.some((x) => x.rep === r.id)) p.contexts.push({ rep: r.id, line: l.name, prefix: sans.slice(0, i) });
      positions.set(k, p);
    }
  }
}
console.log(`${positions.size} positions à examiner (profondeur ${DEPTH}, ${WORKERS} moteurs)${hasMaster ? ", base de maîtres utilisée" : ", rareté d'après le livre d'ouvertures"}`);

// ─── étude d'un coup candidat ────────────────────────────────────────────────
/**
 * `mover` vient de jouer `uci` (le coup surprise) depuis `fen`. On regarde la position du point de vue de l'autre camp :
 * ses réponses qui tiennent, ses réponses naturelles qui sont des erreurs, et ce que `mover` doit savoir ensuite.
 */
async function study(fen, uci, mover) {
  const after = play(fen, uci);
  const replies = await analyse(after, DEPTH - 1, 8); // cp du point de vue de l'adversaire (au trait)
  if (!replies.length) return null;
  const bestDef = replies[0];
  const forMover = (cpOpp) => -cpOpp;
  // réponses qui tiennent : à moins de 0,5 pion de la meilleure défense
  const holding = replies.filter((r) => bestDef.cp - r.cp <= 50);
  // réponses « naturelles » : celles qu'un joueur trouve bonnes en calculant peu (recherche courte) ;
  // un piège, c'est une réponse qui paraît bonne à faible profondeur et qui perd à grande profondeur
  const shallow = await analyse(after, 6, 6);
  const natural = new Map();
  for (const r of shallow) if (r.cp >= shallow[0].cp - 40) natural.set(r.uci, r === shallow[0] ? "premier réflexe" : "coup tentant");
  const traps = [];
  for (const [u, why] of natural) {
    if (holding.some((h) => h.uci === u)) continue;
    let cpOpp = replies.find((r) => r.uci === u)?.cp;
    const fenT = play(after, u);
    const refute = await analyse(fenT, DEPTH - 2, 1); // cp du point de vue de mover
    if (!refute[0]) continue;
    cpOpp = Math.min(cpOpp ?? Infinity, -refute[0].cp);
    const gain = forMover(cpOpp) - forMover(bestDef.cp);
    if (gain >= 120 && forMover(cpOpp) >= 100) {
      const c = new Chess(after);
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      traps.push({ reply: m.san, why: m.captured ? (why === "premier réflexe" ? "prise naturelle" : "prise tentante") : why, eval: forMover(cpOpp), gain, punish: pvSan(fenT, refute[0].pv, 7) });
    }
  }
  // l'adversaire doit-il trouver un coup que le premier réflexe ne donne pas ?
  const hard = shallow[0] && !holding.some((h) => h.uci === shallow[0].uci);
  traps.sort((a, b) => b.gain - a.gain);
  // après la meilleure défense : la suite à connaître, et combien de bons coups a mover (1 = coup précis à mémoriser)
  const fenD = play(after, bestDef.uci);
  const mine = await analyse(fenD, DEPTH - 2, 4);
  const precise = mine.length > 1 && mine[0].cp - mine[1].cp >= 60;
  return {
    eval: forMover(bestDef.cp),
    bestDefense: pvSan(after, bestDef.pv, 8),
    holding: holding.map((r) => sanOf(after, r.uci)).filter(Boolean),
    traps: traps.slice(0, 3),
    hard,
    precise: precise ? sanOf(fenD, mine[0].uci) : null,
  };
}

/** Note pratique 0–100 : peu de réponses qui tiennent, pièges naturels, coût théorique faible. */
function practical(cost, s) {
  // peu de réponses qui tiennent ne compte que si elles ne sautent pas aux yeux (une reprise forcée n'est pas un problème)
  const only = s.hard ? 15 + Math.max(0, 4 - s.holding.length) * 6 : 0;
  const trap = Math.min(45, s.traps.reduce((a, t) => a + Math.min(25, t.gain / 12), 0));
  const fair = Math.max(0, 25 - cost / 2);                       // perte théorique faible
  const sound = s.eval >= -40 ? 10 : s.eval >= -90 ? 0 : -30;
  return Math.max(0, Math.min(100, Math.round(only + trap + fair + sound)));
}

// ─── recherche ───────────────────────────────────────────────────────────────
const found = [];
let done = 0;
const t0 = Date.now();
await Promise.all([...positions.values()].map(async (p) => {
  const turn = new Chess(p.fen).turn();
  const mine = turn === p.side; // arme (pour le joueur) ou alerte (surprise de l'adversaire)
  const top = await analyse(p.fen, DEPTH, 5);
  done++;
  if (done % 25 === 0) process.stdout.write(`\r${done}/${positions.size} positions · ${found.length} trouvailles · ${Math.round((Date.now() - t0) / 60000)} min   `);
  if (!top.length) return;
  const best = top[0];
  // sans base de maîtres, la rareté n'est fiable que tant que la position est encore dans le livre d'ouvertures
  if (!hasMaster) {
    const recent = p.contexts.some((x) => { const b = new Chess(); const fens = [b.fen()]; for (const m of x.prefix) { b.move(m); fens.push(b.fen()); } return fens.slice(-3).some((f) => book.lookup(f)); });
    if (!recent) return;
  }
  for (const cand of top.slice(0, 5)) {
    if (p.repMoves.has(cand.uci)) continue;
    if (!hasMaster && cand.uci === best.uci) continue; // le meilleur coup du moteur est presque toujours la théorie
    const cost = best.cp - cand.cp; // ce que le coup « coûte » par rapport au meilleur, pour le camp qui le joue
    if (cost > (mine ? 45 : 70) || cand.cp < (mine ? -40 : -90)) continue;
    const rare = rarity(p.fen, cand.uci);
    if (!rare) continue;
    const s = await study(p.fen, cand.uci, turn);
    if (!s) continue;
    const score = practical(cost, s);
    // une alerte n'est utile que si elle pose un vrai problème au joueur
    if (!mine && !s.traps.length && s.holding.length > 2) continue;
    if (mine && score < 35) continue;
    found.push({
      kind: mine ? "arme" : "alerte",
      side: p.side, ply: p.ply, fen: p.fen,
      contexts: p.contexts.map((x) => ({ rep: x.rep, line: x.line, prefix: x.prefix.join(" ") })),
      move: sanOf(p.fen, cand.uci), uci: cand.uci,
      mainMove: sanOf(p.fen, best.uci), mainEval: best.cp, eval: cand.cp, cost,
      rarity: rare, ...s, score,
      repMove: mine ? sanOf(p.fen, [...p.repMoves][0]) : null,
    });
  }
}));
save();
for (const e of engines) e.p.kill();

// on garde les meilleures trouvailles : par répertoire, au plus 6 armes et 4 alertes, les plus pratiques d'abord
found.sort((a, b) => b.score - a.score || b.traps.length - a.traps.length);
const byRep = {};
for (const f of found) for (const c of f.contexts) {
  const list = (byRep[c.rep] ??= []);
  const n = list.filter((x) => x.kind === f.kind).length;
  if (n >= (f.kind === "arme" ? 6 : 4)) continue;
  // pas deux trouvailles sur le même coup (transpositions)
  if (list.some((x) => x.uci === f.uci && x.fen === f.fen)) continue;
  list.push({ ...f, contexts: undefined, rep: c.rep, line: c.line, prefix: c.prefix });
}
const total = Object.values(byRep).reduce((s, l) => s + l.length, 0);
writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), depth: DEPTH, source: hasMaster ? "maîtres" : "livre", reps: byRep }));
console.log(`\n${found.length} trouvailles, ${total} gardées pour ${Object.keys(byRep).length} répertoires → ${OUT} (${Math.round((Date.now() - t0) / 60000)} min)`);
