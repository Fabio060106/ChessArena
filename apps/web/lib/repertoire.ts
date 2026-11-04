import { Chess } from "chess.js";
import type { Color, RepertoireGame } from "@chessarena/shared";
import { classify, winPct, type MoveMark } from "./engine";

/**
 * Répertoire d'ouvertures construit automatiquement à partir des parties du joueur.
 *
 * - un arbre par couleur : chaque position (clé = FEN sans les compteurs) → coups joués, nombre, score ;
 * - Stockfish évalue les positions où c'est au joueur de jouer : un coup qui fait perdre ≥ 20 % de
 *   chances de gain (« ? » / « ?? ») devient un EXERCICE ;
 * - l'exercice résolu enregistre le bon coup comme coup de répertoire (« choix »), révisé ensuite
 *   à intervalles croissants (répétition espacée) ;
 * - export PGN avec variantes, importable dans ChessBase.
 */

/** Profondeur du répertoire : les 12 premiers coups de chaque camp. */
export const MAX_PLY = 24;
/** Perte de chances de gain tolérée pour accepter une autre réponse que le premier choix du moteur. */
export const ACCEPT_LOSS = 5;
/** Intervalles de révision (jours) après 1, 2, 3… réussites consécutives. */
export const INTERVALS_DAYS = [1, 3, 7, 21, 60];

export const fenKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");
export const turnOf = (fen: string): Color => (fen.split(" ")[1] === "b" ? "b" : "w");
export const START = new Chess().fen();

export interface MoveStat {
  uci: string;
  san: string;
  count: number;
  /** points du joueur (1 / 0,5 / 0) cumulés sur ces parties */
  points: number;
  lastAt: string;
}
export interface RepNode {
  key: string;
  fen: string;
  ply: number;
  /** coups joués depuis cette position, du plus fréquent au moins fréquent */
  moves: MoveStat[];
  total: number;
}
export interface Tree {
  color: Color;
  nodes: Map<string, RepNode>;
  games: number;
}

/** Évaluation en cache : point de vue des Blancs (centipions, mat = ±10 000) et meilleur coup. */
export interface EvalEntry { cp: number; best: string | null; bestSan: string | null; depth: number }
export interface Choice { uci: string; san: string; learnedAt: string }
export interface Card {
  key: string;
  fen: string;
  color: Color;
  played: string;
  playedSan: string;
  /** nombre de parties où l'erreur a été jouée */
  times: number;
  mark: MoveMark;
  best: string;
  bestSan: string;
  createdAt: string;
  due: string;
  streak: number;
  solved: number;
  failed: number;
  lastReview: string | null;
}
/** Document enregistré côté serveur (un par joueur). */
export interface RepertoireDoc {
  v: 1;
  evals: Record<string, EvalEntry>;
  choices: Record<string, Choice>;
  cards: Record<string, Card>;
}
export const emptyDoc = (): RepertoireDoc => ({ v: 1, evals: {}, choices: {}, cards: {} });

export function asDoc(x: unknown): RepertoireDoc {
  const d = x as Partial<RepertoireDoc> | null;
  if (!d || d.v !== 1) return emptyDoc();
  return { v: 1, evals: d.evals ?? {}, choices: d.choices ?? {}, cards: d.cards ?? {} };
}

const POINTS = { win: 1, draw: 0.5, loss: 0 } as const;

/** Arbre des ouvertures d'une couleur à partir des parties (PGN). */
export function buildTree(games: readonly RepertoireGame[], color: Color, maxPly = MAX_PLY): Tree {
  const nodes = new Map<string, RepNode>();
  let n = 0;
  for (const g of games) {
    if (g.color !== color) continue;
    let sans: string[];
    try { const c = new Chess(); c.loadPgn(g.pgn); sans = c.history(); } catch { continue; }
    if (sans.length === 0) continue;
    n++;
    const c = new Chess();
    for (let ply = 0; ply < Math.min(maxPly, sans.length); ply++) {
      const fen = c.fen();
      const key = fenKey(fen);
      let node = nodes.get(key);
      if (!node) { node = { key, fen, ply, moves: [], total: 0 }; nodes.set(key, node); }
      const m = c.move(sans[ply]!);
      const uci = m.from + m.to + (m.promotion ?? "");
      let st = node.moves.find((x) => x.uci === uci);
      if (!st) { st = { uci, san: m.san, count: 0, points: 0, lastAt: g.endedAt }; node.moves.push(st); }
      st.count++;
      st.points += POINTS[g.outcome];
      if (g.endedAt > st.lastAt) st.lastAt = g.endedAt;
      node.total++;
    }
  }
  for (const node of nodes.values()) node.moves.sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1));
  return { color, nodes, games: n };
}

export function playUci(fen: string, uci: string): { fen: string; san: string } | null {
  try {
    const c = new Chess(fen);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { fen: c.fen(), san: m.san };
  } catch { return null; }
}

/**
 * Positions à faire évaluer par le moteur, les plus jouées d'abord : chaque position où c'est au joueur
 * (meilleur coup + évaluation) et chaque position obtenue après un de ses coups (évaluation).
 */
export function positionsToAnalyse(tree: Tree, doc: RepertoireDoc, limit = 400): string[] {
  const want = new Map<string, number>(); // fen → poids
  for (const node of tree.nodes.values()) {
    if (turnOf(node.fen) !== tree.color) continue;
    const add = (fen: string, w: number) => { if (!doc.evals[fenKey(fen)]) want.set(fen, Math.max(want.get(fen) ?? 0, w)); };
    add(node.fen, node.total + 0.5);
    for (const m of node.moves) { const r = playUci(node.fen, m.uci); if (r) add(r.fen, m.count); }
  }
  return [...want.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([f]) => f);
}

/** Qualité d'un coup du joueur depuis une position, d'après les évaluations en cache. */
export function judge(fen: string, uci: string, doc: RepertoireDoc, color: Color): { mark: MoveMark; loss: number } | null {
  const before = doc.evals[fenKey(fen)];
  const after = playUci(fen, uci);
  const ev = after && doc.evals[fenKey(after.fen)];
  if (!before || !ev) return null;
  const loss = color === "w" ? winPct(before.cp) - winPct(ev.cp) : winPct(ev.cp) - winPct(before.cp);
  return { mark: classify(before.cp, ev.cp, color), loss };
}

/**
 * Crée (ou met à jour) les exercices : une carte par position où le joueur a joué un coup « ? » ou « ?? ».
 * Une position dont le coup de répertoire a déjà été corrigé garde sa carte (et sa progression).
 */
export function syncCards(tree: Tree, doc: RepertoireDoc, now = new Date()): RepertoireDoc {
  const cards = { ...doc.cards };
  for (const node of tree.nodes.values()) {
    if (turnOf(node.fen) !== tree.color) continue;
    const ev = doc.evals[node.key];
    if (!ev?.best) continue;
    // l'erreur la plus répétée dans cette position
    let worst: { m: MoveStat; mark: MoveMark } | null = null;
    for (const m of node.moves) {
      const j = judge(node.fen, m.uci, doc, tree.color);
      if (!j || (j.mark !== "?" && j.mark !== "??")) continue;
      if (!worst || m.count > worst.m.count) worst = { m, mark: j.mark };
    }
    const existing = cards[node.key];
    if (!worst) continue;
    cards[node.key] = existing
      ? { ...existing, played: worst.m.uci, playedSan: worst.m.san, times: worst.m.count, mark: worst.mark, best: ev.best, bestSan: ev.bestSan ?? ev.best }
      : {
          key: node.key, fen: node.fen, color: tree.color, played: worst.m.uci, playedSan: worst.m.san, times: worst.m.count,
          mark: worst.mark, best: ev.best, bestSan: ev.bestSan ?? ev.best, createdAt: now.toISOString(), due: now.toISOString(),
          streak: 0, solved: 0, failed: 0, lastReview: null,
        };
  }
  return { ...doc, cards };
}

export const isDue = (c: Card, now = new Date()) => new Date(c.due) <= now;

/** Enregistre le résultat d'un exercice : bonne réponse → coup de répertoire + prochaine révision plus lointaine. */
export function review(doc: RepertoireDoc, key: string, ok: boolean, answer: { uci: string; san: string } | null, now = new Date()): RepertoireDoc {
  const card = doc.cards[key];
  if (!card) return doc;
  const streak = ok ? card.streak + 1 : 0;
  const days = ok ? INTERVALS_DAYS[Math.min(streak - 1, INTERVALS_DAYS.length - 1)]! : 1;
  const next: Card = {
    ...card, streak, solved: card.solved + (ok ? 1 : 0), failed: card.failed + (ok ? 0 : 1),
    lastReview: now.toISOString(), due: new Date(now.getTime() + days * 86_400_000).toISOString(),
  };
  const choice = answer ?? { uci: card.best, san: card.bestSan };
  return {
    ...doc,
    cards: { ...doc.cards, [key]: next },
    // la bonne réponse (ou, après échec, celle du moteur) devient le coup de répertoire
    choices: { ...doc.choices, [key]: { uci: choice.uci, san: choice.san, learnedAt: now.toISOString() } },
  };
}

/** Coup de répertoire dans une position où c'est au joueur : coup corrigé, sinon le plus joué. */
export function repertoireMove(node: RepNode | undefined, key: string, doc: RepertoireDoc): { uci: string; san: string; learned: boolean } | null {
  const ch = doc.choices[key];
  if (ch) return { uci: ch.uci, san: ch.san, learned: true };
  const m = node?.moves[0];
  return m ? { uci: m.uci, san: m.san, learned: false } : null;
}

/** Ligne lisible d'une suite de SAN depuis le début : « 1.e4 Cf6 2.e5 ». */
export function lineLabel(sans: readonly string[]): string {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(" ");
}

/** Chemin (SAN depuis la position initiale) menant à chaque position de l'arbre, par les coups les plus joués. */
export function pathsTo(tree: Tree): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const queue: Array<{ fen: string; sans: string[] }> = [{ fen: START, sans: [] }];
  paths.set(fenKey(START), []);
  while (queue.length) {
    const { fen, sans } = queue.shift()!;
    const node = tree.nodes.get(fenKey(fen));
    if (!node) continue;
    for (const m of node.moves) {
      const r = playUci(fen, m.uci);
      if (!r || paths.has(fenKey(r.fen))) continue;
      const p = [...sans, m.san];
      paths.set(fenKey(r.fen), p);
      queue.push({ fen: r.fen, sans: p });
    }
  }
  return paths;
}

// ─── Export PGN (ChessBase, Lichess, Chessable…) ─────────────────────────────

interface Opt { uci: string; san: string; comment?: string; nag?: string }

/**
 * Répertoire d'une couleur en PGN avec variantes :
 * - à ton trait : ton coup de répertoire (corrigé ou le plus joué), et tes erreurs passées en sous-variantes annotées ;
 * - au trait adverse : toutes les réponses rencontrées, de la plus fréquente à la plus rare.
 */
export function exportPgn(tree: Tree, doc: RepertoireDoc, player: string, date = new Date()): string {
  const color = tree.color;
  const optionsAt = (fen: string): Opt[] => {
    const key = fenKey(fen);
    const node = tree.nodes.get(key);
    if (turnOf(fen) === color) {
      const rep = repertoireMove(node, key, doc);
      if (!rep) return [];
      const n = node?.moves.find((m) => m.uci === rep.uci);
      const main: Opt = { uci: rep.uci, san: rep.san, comment: rep.learned ? (n ? `coup de répertoire (corrigé) - joué ${n.count} fois` : "coup de répertoire (appris à l'entraînement)") : n && n.count > 1 ? `joué ${n.count} fois - ${Math.round((100 * n.points) / n.count)} %` : undefined };
      const errs: Opt[] = (node?.moves ?? []).filter((m) => m.uci !== rep.uci).flatMap((m) => {
        const j = judge(fen, m.uci, doc, color);
        if (!j?.mark) return [];
        return [{ uci: m.uci, san: m.san, nag: j.mark === "??" ? "$4" : j.mark === "?" ? "$2" : "$6", comment: `ton ancienne erreur - jouée ${m.count} fois` }];
      });
      return [main, ...errs];
    }
    return (node?.moves ?? []).map((m) => ({ uci: m.uci, san: m.san, comment: tree.games > 1 ? `${m.count} fois - ton score ${Math.round((100 * m.points) / m.count)} %` : undefined }));
  };

  const num = (ply: number, force: boolean) => (ply % 2 === 0 ? `${ply / 2 + 1}. ` : force ? `${(ply + 1) / 2}... ` : "");
  const tok = (o: Opt, ply: number, force: boolean) =>
    `${num(ply, force)}${o.san}${o.nag ? ` ${o.nag}` : ""}${o.comment ? ` {${o.comment.replace(/[{}]/g, "")}}` : ""}`;

  const walk = (fen: string, ply: number, force: boolean, seen: Set<string>): string => {
    if (ply >= MAX_PLY + 2) return "";
    const key = fenKey(fen);
    if (seen.has(key)) return "";
    const opts = optionsAt(fen);
    if (opts.length === 0) return "";
    const next = new Set(seen).add(key);
    const [main, ...alts] = opts;
    const mainFen = playUci(fen, main!.uci)?.fen;
    let s = tok(main!, ply, force);
    for (const alt of alts) {
      const f = playUci(fen, alt.uci)?.fen;
      const cont = f && !alt.nag ? walk(f, ply + 1, !!alt.comment, next) : ""; // pas de suite après une erreur
      s += ` (${tok(alt, ply, true)}${cont ? ` ${cont}` : ""})`;
    }
    const cont = mainFen ? walk(mainFen, ply + 1, alts.length > 0 || !!main!.comment, next) : "";
    return cont ? `${s} ${cont}` : s;
  };

  const d = date.toISOString().slice(0, 10).replace(/-/g, ".");
  const headers = [
    `[Event "Répertoire ChessArena - ${color === "w" ? "Blancs" : "Noirs"}"]`,
    `[Site "ChessArena"]`, `[Date "${d}"]`, `[Round "-"]`,
    `[White "${color === "w" ? player : "Répertoire"}"]`, `[Black "${color === "b" ? player : "Répertoire"}"]`,
    `[Result "*"]`, `[Annotator "ChessArena - Stockfish 19"]`,
  ].join("\n");
  const body = walk(START, 0, false, new Set());
  return `${headers}\n\n${wrap(`${body}${body ? " " : ""}*`)}\n`;
}

/** Lignes de 80 caractères au plus (recommandation du standard PGN). */
function wrap(text: string, width = 80): string {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join("\n");
}
