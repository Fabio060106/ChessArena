import { Chess } from "chess.js";
import type { Color } from "@chessarena/shared";
import { REPERTOIRES, repertoireById, type RepertoireDef } from "./repertoireBook";
import { buildTree as buildRefTree, type RepNode as RefNode } from "./repertoireStudy";
import { epdOf, frenchOpening, type OpeningBook } from "./openingBook";
import { sublineIdea } from "./openingIdeas";
import { ideaOf, moveFacts } from "./commentary";
import type { MoveStat } from "./repertoire";
import type { MasterMove } from "./masterDb";

/**
 * Le « coach » de l'arbre de répertoire : dans chaque position, ce qu'un GM dirait à côté de l'échiquier.
 * Le nom de la variante et son idée, l'explication du dernier coup, ce que prévoit le répertoire de référence,
 * toutes les sous-lignes de la théorie (pas seulement celles des parties du joueur), et des pistes à creuser.
 */

export interface RefRepertoire { id: string; sections: RepertoireDef[]; tree: Map<string, RefNode> }

export function refRepertoire(id: string): RefRepertoire | null {
  const r = repertoireById(id);
  if (!r) return null;
  const sections = [r, ...(r.with ?? []).map(repertoireById).filter((x): x is RepertoireDef => !!x)];
  return { id, sections, tree: buildRefTree(sections) };
}

/** Les répertoires de référence d'une couleur, du plus proche des parties du joueur au moins proche. */
export function rankRepertoires(color: Color, played: ReadonlySet<string>): Array<{ id: string; title: string; overlap: number }> {
  return REPERTOIRES.filter((r) => r.side === color && !r.id.includes("complement") && !r.id.includes("sidelines"))
    .map((r) => {
      const t = buildRefTree([r]);
      let overlap = 0;
      for (const k of t.keys()) if (played.has(k)) overlap++;
      return { id: r.id, title: r.title, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap);
}

export interface CoachMove {
  san: string;
  uci: string;
  /** lignes du répertoire de référence qui jouent ce coup */
  rep: string[];
  /** sous-variante de la théorie (nom du livre) et son idée */
  theory: { name: string; eco: string; idea: string | null } | null;
  /** dans les parties du joueur */
  games: { count: number; score: number } | null;
  /** dans les parties de maîtres (si la base est installée) : part des parties, score pour le camp au trait, Elo moyen */
  master: { games: number; share: number; score: number; elo: number; year: number } | null;
}

export interface CoachView {
  name: string | null;
  eco: string | null;
  /** explication du dernier coup joué */
  comment: string[];
  /** notes du répertoire de référence pour les lignes qui passent ici */
  notes: Array<{ line: string; note: string; end: boolean }>;
  moves: CoachMove[];
  /** pistes à creuser : des questions, pas des réponses */
  leads: string[];
}

const num = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "…"}`;

export function coachAt(p: {
  line: ReadonlyArray<{ uci: string; san: string; fen: string }>;
  color: Color;
  book: OpeningBook | null;
  ref: RefRepertoire | null;
  userMoves: readonly MoveStat[];
  /** coups des maîtres dans cette position (base de parties, facultative) */
  master?: readonly MasterMove[];
}): CoachView {
  const fens = [new Chess().fen(), ...p.line.map((x) => x.fen)];
  const fen = fens.at(-1)!;
  const ply = p.line.length;
  const key = epdOf(fen);
  // nom de la variante : la position nommée la plus récente
  let entry: { name: string; eco: string; at: number } | null = null;
  if (p.book) for (let i = fens.length - 1; i >= 0; i--) { const e = p.book.lookup(fens[i]!); if (e) { entry = { name: e.name, eco: e.eco, at: i }; break; } }
  const comment: string[] = [];
  if (ply > 0) {
    const last = p.line.at(-1)!;
    const f = moveFacts(fens[ply - 1]!, last.uci, ply, ply > 1 && p.line[ply - 2]!.san.includes("x") ? p.line[ply - 2]!.uci.slice(2, 4) : null);
    const idea = f ? ideaOf(f, ply <= 20) : "";
    if (idea) comment.push(`${num(ply)} ${last.san} — ${idea}`);
    if (entry && entry.at === ply) {
      comment.push(`On entre dans la ${frenchOpening(entry.name).replace(/^(Défense|Partie|Ouverture|Gambit|Système|Attaque)/, (w) => w.toLowerCase())} (${entry.eco}).`.replace("la gambit", "le gambit").replace("la système", "le système").replace("la attaque", "l'attaque").replace("la ouverture", "l'ouverture"));
      const si = sublineIdea(entry.name);
      if (si) comment.push(si);
    }
  }
  // répertoire de référence : les lignes qui passent par cette position
  const notes: CoachView["notes"] = [];
  if (p.ref) {
    for (const r of p.ref.sections) for (const l of r.lines) {
      const c = new Chess();
      const sans = l.moves.split(" ");
      let here = epdOf(c.fen()) === key ? 0 : -1;
      for (let i = 0; i < sans.length && here < 0; i++) { c.move(sans[i]!); if (epdOf(c.fen()) === key) here = i + 1; }
      if (here >= 0) notes.push({ line: l.name, note: l.note, end: here === sans.length });
    }
  }
  // coups possibles : répertoire, théorie, parties du joueur
  const map = new Map<string, CoachMove>();
  const add = (uci: string, san: string) => { const m = map.get(uci) ?? { san, uci, rep: [], theory: null, games: null, master: null }; map.set(uci, m); return m; };
  const refNode = p.ref?.tree.get(key);
  if (refNode) for (const [san, v] of refNode.moves) add(v.uci, san).rep = v.lines;
  if (p.book) for (const b of p.book.mainBranches(fen)) {
    // l'idée propre à la sous-variante (pas celle, générale, de la famille, déjà donnée plus haut)
    const own = sublineIdea(b.name), fam = sublineIdea(b.name.split(":")[0]!);
    add(b.uci, b.san).theory = { name: frenchOpening(b.name), eco: b.eco, idea: own && own !== fam ? own.split(/(?<=[.!]) /)[0]! : null };
  }
  for (const m of p.userMoves) add(m.uci, m.san).games = { count: m.count, score: Math.round((100 * m.points) / m.count) };
  const turn: Color = fen.split(" ")[1] === "w" ? "w" : "b";
  // coups des maîtres : ceux joués dans au moins 3 % des parties (les autres sont des curiosités)
  for (const m of p.master ?? []) if (m.share >= 3 || map.has(m.uci)) add(m.uci, m.san).master = { games: m.games, share: m.share, score: Math.round((turn === "w" ? m.white : m.black) + m.draw / 2), elo: m.elo, year: m.year };
  const moves = [...map.values()].sort((a, b) => (b.rep.length ? 1 : 0) - (a.rep.length ? 1 : 0) || (b.games?.count ?? 0) - (a.games?.count ?? 0) || (b.master?.games ?? 0) - (a.master?.games ?? 0) || (b.theory ? 1 : 0) - (a.theory ? 1 : 0));

  // pistes à creuser
  const leads: string[] = [];
  const mine = (fen.split(" ")[1] === "w" ? "w" : "b") === p.color;
  const theoryOnly = moves.filter((m) => m.theory && !m.games);
  const myBad = moves.filter((m) => m.games && m.games.count >= 2 && m.games.score <= 35);
  const repMove = moves.find((m) => m.rep.length);
  if (mine) {
    const myMain = [...p.userMoves].sort((a, b) => b.count - a.count)[0];
    if (repMove && myMain && myMain.uci !== repMove.uci) leads.push(`Tu joues surtout ${myMain.san} ici, le répertoire de référence prévoit ${repMove.san}. Qu'est-ce qui change dans la structure de pions et dans le placement des pièces ?`);
    if (theoryOnly.length) leads.push(`La théorie connaît aussi ${theoryOnly.slice(0, 2).map((m) => m.san).join(" et ")} : quelle idée cherche ce coup, et pourquoi ne l'as-tu jamais essayé ?`);
    for (const m of myBad.slice(0, 1)) leads.push(`Avec ${m.san}, tu marques ${m.games!.score} % (${m.games!.count} parties) : rejoue une de ces parties et cherche le moment où le plan s'est perdu.`);
  } else {
    const often = [...p.userMoves].sort((a, b) => b.count - a.count)[0];
    if (often && !often.san.startsWith("O") && !moves.find((x) => x.uci === often.uci)?.rep.length && p.ref) leads.push(`Tes adversaires jouent souvent ${often.san} (${often.count} fois) et ton répertoire ne le couvre pas : quel est le point faible de ce coup ?`);
    if (theoryOnly.length) leads.push(`Tu n'as jamais rencontré ${theoryOnly.slice(0, 2).map((m) => `${m.san}${m.theory?.name.includes(":") ? ` (${m.theory.name.split(":").slice(1).join(":").trim()})` : ""}`).join(", ")} : que ferais-tu contre ?`);
    for (const m of myBad.slice(0, 1)) leads.push(`Contre ${m.san}, ton score est de ${m.games!.score} % : quel plan te manque dans cette position ?`);
  }
  // ce que font les maîtres ici
  const top = [...moves].filter((m) => m.master).sort((a, b) => b.master!.games - a.master!.games)[0];
  if (top && top.master!.games >= 10) {
    if (mine && repMove && top.uci !== repMove.uci && !repMove.master) leads.push(`Les maîtres jouent surtout ${top.san} ici (${top.master!.share} % des parties) et presque jamais ${repMove.san}, le coup du répertoire : pourquoi ? Compare les deux structures.`);
    else if (mine && repMove && top.uci !== repMove.uci) leads.push(`Les maîtres préfèrent ${top.san} (${top.master!.share} %, ${top.master!.score} % de score) au ${repMove.san} du répertoire (${repMove.master!.share} %) : qu'apporte chaque coup ?`);
    else if (!mine && p.ref && !top.rep.length && !refNode?.moves.size) { /* fin du répertoire : rien à dire de plus */ }
    else if (!mine && p.ref && !top.rep.length) leads.push(`Chez les maîtres, la réponse la plus jouée est ${top.san} (${top.master!.share} % des parties) et ton répertoire ne la traite pas : prépare un plan contre ce coup.`);
  }
  if (notes.some((n) => n.end)) leads.push("Fin de la ligne du répertoire : quel est le plan de milieu de jeu pour toi ? Cherche une partie de maître avec cette structure.");
  return { name: entry ? frenchOpening(entry.name) : null, eco: entry?.eco ?? null, comment, notes, moves, leads: leads.slice(0, 3) };
}
