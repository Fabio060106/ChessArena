import { Chess } from "chess.js";
import type { RepertoireGame } from "@chessarena/shared";
import { scoreToCp, winPct, type EngineLine } from "./engine";
import { isEndgame, moveFacts, VALUE } from "./commentary";

/**
 * Le style d'un joueur, lu dans ses parties :
 * - sans moteur : les structures qu'il obtient (centre ouvert, semi-ouvert, fermé) et son score dans chacune,
 *   les roques opposés et attaques de pions, les sacrifices, les finales ;
 * - avec Stockfish (analyse approfondie d'un échantillon) : sa précision par phase (ouverture, milieu, finale),
 *   le type de ses erreurs (pièce laissée en prise, tactique manquée, erreur de jugement), sa capacité à
 *   convertir un avantage et à sauver une position perdue.
 */

export type Structure = "open" | "semi" | "closed";
const PTS = { win: 1, draw: 0.5, loss: 0 } as const;

interface Facts {
  color: "w" | "b";
  outcome: "win" | "loss" | "draw";
  sans: string[];
  fens: string[];
  ucis: string[];
  structure: Structure | null;
  /** le joueur a attaqué le roi adverse avec ses pions (roques opposés ou poussée g/h) */
  attack: boolean;
  /** le joueur a joué avec du matériel en moins pendant plusieurs coups en début de partie (gambit, sacrifice) */
  sacrifice: boolean;
  endgame: boolean;
  at: string;
}

function material(c: Chess, color: "w" | "b"): number {
  let v = 0;
  for (const row of c.board()) for (const p of row) if (p) v += (p.color === color ? 1 : -1) * VALUE[p.type]!;
  return v;
}

/** Structure du centre après le 15e coup : fermé (pions centraux bloqués), ouvert (peu de pions centraux), semi-ouvert sinon. */
export function structureOf(fen: string): Structure {
  const c = new Chess(fen);
  let central = 0;
  let blocked = false;
  for (const f of ["c", "d", "e", "f"]) {
    for (let r = 2; r <= 7; r++) {
      const p = c.get(`${f}${r}` as never) as { type: string; color: string } | undefined;
      if (p?.type !== "p") continue;
      if (f === "d" || f === "e") central++;
      const front = c.get(`${f}${p.color === "w" ? r + 1 : r - 1}` as never) as { type: string; color: string } | undefined;
      if ((f === "d" || f === "e") && front?.type === "p" && front.color !== p.color) blocked = true;
    }
  }
  if (blocked && central >= 3) return "closed";
  if (central <= 1) return "open";
  return "semi";
}

function factsOf(g: RepertoireGame): Facts | null {
  const c = new Chess();
  try { c.loadPgn(g.pgn); } catch { return null; }
  const hist = c.history({ verbose: true });
  if (hist.length < 10) return null;
  const b = new Chess();
  const fens = [b.fen()];
  const ucis: string[] = [];
  const me = g.color;
  let down = 0, sacrifice = false, attack = false;
  let myKing: "k" | "q" | null = null, theirKing: "k" | "q" | null = null;
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i]!;
    b.move(m.san);
    fens.push(b.fen());
    ucis.push(m.from + m.to + (m.promotion ?? ""));
    if (m.san.startsWith("O-O")) { const side = m.san === "O-O" ? "k" : "q"; if (m.color === me) myKing = side; else theirKing = side; }
    if (i < 60) {
      down = material(b, me) <= -2 ? down + 1 : 0;
      if (down >= 4) sacrifice = true;
    }
    // poussée des pions g/h (ou a/b) vers le roi adverse, entre le 8e et le 30e coup
    if (m.color === me && m.piece === "p" && i >= 16 && i <= 60 && theirKing) {
      const wing = theirKing === "k" ? ["g", "h"] : ["a", "b"];
      const adv = me === "w" ? Number(m.to[1]) >= 4 : Number(m.to[1]) <= 5;
      if (wing.includes(m.to[0]!) && adv && myKing !== theirKing) attack = true;
    }
  }
  if (myKing && theirKing && myKing !== theirKing) attack = true;
  return {
    color: me, outcome: g.outcome, sans: hist.map((m) => m.san), fens, ucis,
    structure: fens.length > 16 ? structureOf(fens[Math.min(30, fens.length - 1)]!) : null,
    attack, sacrifice, endgame: fens.slice(0, 120).some((f, i) => i > 20 && isEndgame(f)), at: g.endedAt,
  };
}

export interface Bucket { games: number; score: number | null }
const bucket = (xs: Facts[]): Bucket => ({ games: xs.length, score: xs.length ? Math.round((100 * xs.reduce((s, f) => s + PTS[f.outcome], 0)) / xs.length) : null });

export interface DeepStats {
  games: number;
  /** perte moyenne de chances de gain par coup (en %), par phase */
  loss: { opening: number | null; middle: number | null; endgame: number | null };
  /** nombre d'erreurs (perte ≥ 20 %) par type */
  errors: { hanging: number; missedTactic: number; judgement: number };
  /** parties où le joueur a eu un avantage décisif (≥ 80 % de chances) sans gagner */
  notConverted: number;
  winning: number;
  /** parties où le joueur était perdu (≤ 20 %) et a sauvé la nulle ou gagné */
  saved: number;
  losing: number;
}

export interface StyleReport {
  games: number;
  structures: Record<Structure, Bucket>;
  attack: Bucket;
  sacrifice: Bucket;
  endgame: Bucket;
  deep: DeepStats | null;
  /** 0–100 */
  axes: Array<{ id: "opening" | "middle" | "endgame" | "attack" | "defense" | "risk"; label: string; value: number | null; hint: string }>;
  /** phrases tirées des parties */
  findings: string[];
}

export function staticFacts(games: readonly RepertoireGame[]): Facts[] {
  return games.map(factsOf).filter((x): x is Facts => !!x);
}

export function buildStyle(games: readonly RepertoireGame[], deep: DeepStats | null = null): StyleReport {
  const fs = staticFacts(games);
  const S = (k: Structure) => bucket(fs.filter((f) => f.structure === k));
  const structures = { open: S("open"), semi: S("semi"), closed: S("closed") };
  const attack = bucket(fs.filter((f) => f.attack));
  const sacrifice = bucket(fs.filter((f) => f.sacrifice));
  const endgame = bucket(fs.filter((f) => f.endgame));
  const n = fs.length;
  const share = (b: Bucket) => (n ? Math.round((100 * b.games) / n) : 0);
  const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
  // précision par phase → note sur 100 (perte moyenne de 0 % = 100, de 8 % ou plus = 0)
  const acc = (l: number | null | undefined) => (l === null || l === undefined ? null : clamp(100 - (l / 8) * 100));
  const axes: StyleReport["axes"] = [
    { id: "opening", label: "Ouverture", value: acc(deep?.loss.opening), hint: "précision dans les 12 premiers coups" },
    { id: "middle", label: "Milieu de jeu", value: acc(deep?.loss.middle), hint: "précision et tactique au milieu de jeu" },
    { id: "endgame", label: "Finales", value: deep?.loss.endgame !== null && deep?.loss.endgame !== undefined ? acc(deep.loss.endgame) : endgame.games >= 5 ? endgame.score : null, hint: deep ? "précision en finale" : "score dans les parties qui vont jusqu'à la finale" },
    { id: "attack", label: "Goût de l'attaque", value: n ? clamp(share(attack) * 1.6) : null, hint: "roques opposés, poussées de pions contre le roi" },
    { id: "risk", label: "Prise de risque", value: n ? clamp(share(sacrifice) * 4 + (100 - share(bucket(fs.filter((f) => f.outcome === "draw")))) * 0.3) : null, hint: "gambits et sacrifices, parties décisives" },
    { id: "defense", label: "Défense", value: deep && deep.losing >= 3 ? clamp((100 * deep.saved) / deep.losing * 2) : null, hint: "positions perdues sauvées" },
  ];
  // ce que révèlent les parties
  const findings: string[] = [];
  const cmp = (a: Bucket, b: Bucket) => a.games >= 5 && b.games >= 5 && a.score !== null && b.score !== null ? a.score - b.score : 0;
  const d1 = cmp(structures.open, structures.closed);
  if (d1 >= 10) findings.push(`Tu marques ${structures.open.score} % quand le centre est ouvert, contre ${structures.closed.score} % quand il est fermé : tu es plus à l'aise dans les positions ouvertes, où les pièces sont actives.`);
  else if (d1 <= -10) findings.push(`Tu marques ${structures.closed.score} % quand le centre est fermé, contre ${structures.open.score} % quand il est ouvert : tu es plus à l'aise dans les positions fermées et stratégiques.`);
  if (attack.games >= 5 && attack.score !== null) findings.push(`Dans ${share(attack)} % de tes parties tu attaques le roi adverse (roques opposés ou poussées de pions) ; tu y marques ${attack.score} %.`);
  if (sacrifice.games >= 3 && sacrifice.score !== null) findings.push(`Tu joues ${sacrifice.games} parties avec du matériel en moins en début de partie (gambits, sacrifices) : ${sacrifice.score} % de score.`);
  if (endgame.games >= 5 && endgame.score !== null) findings.push(`Tes parties qui vont jusqu'à la finale : ${endgame.score} % de score (${endgame.games} parties).`);
  if (deep) {
    const ph = [["l'ouverture", deep.loss.opening], ["le milieu de jeu", deep.loss.middle], ["la finale", deep.loss.endgame]] as const;
    const known = ph.filter((x) => x[1] !== null).sort((a, b) => b[1]! - a[1]!);
    const worst = known.length >= 2 ? known[0] : undefined;
    if (worst) findings.push(`D'après Stockfish (${deep.games} parties analysées), c'est dans ${worst[0]} que tu perds le plus de points : en moyenne ${worst[1]!.toFixed(1).replace(".", ",")} % de chances de gain perdues par coup (contre ${known.at(-1)![1]!.toFixed(1).replace(".", ",")} % dans ${known.at(-1)![0]}).`);
    const e = deep.errors, tot = e.hanging + e.missedTactic + e.judgement;
    if (tot >= 3) {
      const main = e.hanging >= e.missedTactic && e.hanging >= e.judgement ? `des pièces laissées sans défense (${e.hanging} sur ${tot})` : e.missedTactic >= e.judgement ? `des coups tactiques manqués (${e.missedTactic} sur ${tot})` : `des erreurs de jugement dans des positions calmes (${e.judgement} sur ${tot})`;
      findings.push(`Tes erreurs viennent surtout ${main}.`);
    }
    if (deep.winning >= 3) findings.push(deep.notConverted / deep.winning >= 0.35 ? `Tu as laissé échapper ${deep.notConverted} parties gagnantes sur ${deep.winning} : la conversion de l'avantage est à travailler (simplifier, échanger, limiter le contre-jeu).` : `Quand tu prends un avantage décisif, tu le convertis bien (${deep.winning - deep.notConverted} sur ${deep.winning}).`);
    if (deep.losing >= 3) findings.push(deep.saved / deep.losing >= 0.25 ? `Tu sais te défendre : ${deep.saved} positions perdues sauvées sur ${deep.losing}.` : `Les positions difficiles te réussissent peu (${deep.saved} sauvée${deep.saved > 1 ? "s" : ""} sur ${deep.losing}) : des ouvertures solides t'éviteront de t'y retrouver.`);
  }
  return { games: n, structures, attack, sacrifice, endgame, deep, axes, findings };
}

const winFor = (l: EngineLine, c: "w" | "b") => { const w = winPct(scoreToCp(l.score)); return c === "w" ? w : 100 - w; };

/**
 * Analyse approfondie (Stockfish) d'un échantillon de parties : précision par phase, types d'erreurs,
 * conversion et défense. `evaluate` analyse une position (profondeur réduite pour aller vite).
 */
export async function deepAnalyse(
  games: readonly RepertoireGame[],
  evaluate: (fen: string) => Promise<EngineLine | null>,
  opts: { maxGames?: number; maxPlies?: number; onProgress?: (done: number, total: number) => void; cancelled?: () => boolean } = {},
): Promise<DeepStats | null> {
  const fs = staticFacts(games).filter((f) => f.sans.length >= 20).sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts.maxGames ?? 20);
  if (!fs.length) return null;
  const maxPlies = opts.maxPlies ?? 90;
  const total = fs.reduce((s, f) => s + Math.min(f.fens.length, maxPlies + 1), 0);
  let done = 0;
  const loss = { opening: [] as number[], middle: [] as number[], endgame: [] as number[] };
  const errors = { hanging: 0, missedTactic: 0, judgement: 0 };
  let winning = 0, notConverted = 0, losing = 0, saved = 0;
  for (const f of fs) {
    const ev: Array<EngineLine | null> = [];
    for (let i = 0; i < Math.min(f.fens.length, maxPlies + 1); i++) {
      if (opts.cancelled?.()) return null;
      ev.push(await evaluate(f.fens[i]!));
      opts.onProgress?.(++done, total);
    }
    let hadWin = false, hadLoss = false;
    for (let i = 0; i + 1 < ev.length; i++) {
      const a = ev[i], b = ev[i + 1];
      if (!a || !b) continue;
      const mover = i % 2 === 0 ? "w" : "b";
      const w = winFor(a, f.color);
      if (w >= 80) hadWin = true;
      if (w <= 20) hadLoss = true;
      if (mover !== f.color) continue;
      const l = Math.max(0, winFor(a, mover) - winFor(b, mover));
      const phase = isEndgame(f.fens[i]!) ? "endgame" : i < 24 ? "opening" : "middle";
      loss[phase].push(l);
      if (l >= 20) {
        const reply = b.pv[0] ? moveFacts(f.fens[i + 1]!, b.pv[0], i + 2) : null;
        const best = a.pv[0] ? moveFacts(f.fens[i]!, a.pv[0], i + 1) : null;
        if (reply?.captured && VALUE[reply.captured]! >= 3) errors.hanging++;
        else if (best && (best.mate || (best.captured && VALUE[best.captured]! >= 3) || best.targets.filter((t) => t.value >= 3).length >= 2)) errors.missedTactic++;
        else errors.judgement++;
      }
    }
    if (hadWin) { winning++; if (f.outcome !== "win") notConverted++; }
    if (hadLoss) { losing++; if (f.outcome !== "loss") saved++; }
  }
  const mean = (xs: number[]) => (xs.length >= 5 ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return { games: fs.length, loss: { opening: mean(loss.opening), middle: mean(loss.middle), endgame: mean(loss.endgame) }, errors, notConverted, winning, saved, losing };
}
