import { Chess } from "chess.js";

/**
 * Arbre d'analyse : chaque position peut avoir plusieurs suites (la première est la ligne principale,
 * les autres sont des variantes, elles-mêmes ramifiées sans limite). Structure immuable : chaque opération
 * renvoie un nouvel arbre (rendu React simple, retour arrière facile).
 */
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface TreeNode {
  id: string;
  fen: string;
  san: string | null;
  uci: string | null;
  parent: string | null;
  children: string[];
  /** nombre de demi-coups depuis la racine */
  ply: number;
}

export interface Tree {
  root: string;
  nodes: Record<string, TreeNode>;
}

let seq = 0;
const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newTree(fen: string = START_FEN): Tree {
  const id = newId();
  return { root: id, nodes: { [id]: { id, fen, san: null, uci: null, parent: null, children: [], ply: 0 } } };
}

/** Joue un coup (from, to, promotion) depuis une position ; null s'il est illégal. */
export function legalMove(fen: string, from: string, to: string, promotion?: string): { fen: string; san: string; uci: string; captured: boolean; check: boolean; castle: boolean } | null {
  try {
    const c = new Chess(fen);
    const m = c.move({ from, to, promotion });
    return { fen: c.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? ""), captured: !!m.captured, check: c.inCheck(), castle: m.san.startsWith("O-O") };
  } catch {
    return null;
  }
}

export const playUci = (fen: string, uci: string) => legalMove(fen, uci.slice(0, 2), uci.slice(2, 4), uci[4] || undefined);

/** Ajoute un coup après `parentId` (ou retrouve la suite existante) ; renvoie l'arbre et le nœud atteint. */
export function addMove(tree: Tree, parentId: string, step: { fen: string; san: string; uci: string }): { tree: Tree; id: string } {
  const parent = tree.nodes[parentId];
  if (!parent) return { tree, id: parentId };
  const existing = parent.children.find((c) => tree.nodes[c]!.uci === step.uci);
  if (existing) return { tree, id: existing };
  const id = newId();
  return {
    id,
    tree: {
      root: tree.root,
      nodes: {
        ...tree.nodes,
        [parentId]: { ...parent, children: [...parent.children, id] },
        [id]: { id, fen: step.fen, san: step.san, uci: step.uci, parent: parentId, children: [], ply: parent.ply + 1 },
      },
    },
  };
}

/** Joue une suite de coups UCI depuis un nœud ; s'arrête au premier coup illégal. */
export function addUcis(tree: Tree, fromId: string, ucis: readonly string[]): { tree: Tree; id: string } {
  let t = tree; let id = fromId;
  for (const u of ucis) {
    const m = playUci(t.nodes[id]!.fen, u);
    if (!m) break;
    ({ tree: t, id } = addMove(t, id, m));
  }
  return { tree: t, id };
}

/** Nœuds de la racine jusqu'à `id` inclus. */
export function pathTo(tree: Tree, id: string): string[] {
  const out: string[] = [];
  for (let n: TreeNode | undefined = tree.nodes[id]; n; n = n.parent ? tree.nodes[n.parent] : undefined) out.push(n.id);
  return out.reverse();
}

/** Dernière position en suivant la première suite à chaque fois. */
export function lineEnd(tree: Tree, id: string): string {
  let n = tree.nodes[id]!;
  while (n.children.length) n = tree.nodes[n.children[0]!]!;
  return n.id;
}

/** Ligne principale complète (racine comprise). */
export function mainline(tree: Tree): string[] {
  const out = [tree.root];
  let n = tree.nodes[tree.root]!;
  while (n.children.length) { n = tree.nodes[n.children[0]!]!; out.push(n.id); }
  return out;
}

export function isMainline(tree: Tree, id: string): boolean {
  for (let n = tree.nodes[id]; n?.parent; n = tree.nodes[n.parent]) {
    if (tree.nodes[n.parent]!.children[0] !== n.id) return false;
  }
  return true;
}

/** Point de départ de la variante qui contient `id` : le premier ancêtre (ou lui-même) qui n'est pas la 1re suite. */
export function branchPoint(tree: Tree, id: string): string | null {
  for (let n = tree.nodes[id]; n?.parent; n = tree.nodes[n.parent]) {
    if (tree.nodes[n.parent]!.children[0] !== n.id) return n.id;
  }
  return null;
}

/** Remonte la variante d'un cran : elle devient la suite principale à son point de départ. */
export function promote(tree: Tree, id: string): Tree {
  const b = branchPoint(tree, id);
  if (!b) return tree;
  const node = tree.nodes[b]!;
  const parent = tree.nodes[node.parent!]!;
  return { root: tree.root, nodes: { ...tree.nodes, [parent.id]: { ...parent, children: [b, ...parent.children.filter((c) => c !== b)] } } };
}

/** Supprime un coup et toute sa suite ; renvoie l'arbre et la position d'avant. */
export function remove(tree: Tree, id: string): { tree: Tree; id: string } {
  const node = tree.nodes[id];
  if (!node?.parent) return { tree, id };
  const nodes = { ...tree.nodes };
  const drop = (x: string) => { for (const c of nodes[x]!.children) drop(c); delete nodes[x]; };
  drop(id);
  const parent = nodes[node.parent]!;
  nodes[parent.id] = { ...parent, children: parent.children.filter((c) => c !== id) };
  return { tree: { root: tree.root, nodes }, id: parent.id };
}

/** Coups UCI de la racine jusqu'au nœud. */
export function ucisTo(tree: Tree, id: string): string[] {
  return pathTo(tree, id).slice(1).map((x) => tree.nodes[x]!.uci!);
}

/** Tous les nœuds, ligne principale d'abord puis les variantes (parcours en profondeur). */
export function allNodes(tree: Tree): string[] {
  const main = mainline(tree);
  const seen = new Set(main);
  const out = [...main];
  const walk = (id: string) => {
    for (const c of tree.nodes[id]!.children) {
      if (!seen.has(c)) { seen.add(c); out.push(c); }
      walk(c);
    }
  };
  walk(tree.root);
  return out;
}

/** « 12. », « 12… » selon le trait de la position d'avant. */
export function moveNumber(beforeFen: string, force: boolean): string {
  const [, turn, , , , full] = beforeFen.split(" ");
  if (turn === "w") return `${full}. `;
  return force ? `${full}… ` : "";
}

// ─── PGN avec variantes ──────────────────────────────────────────────────────

/** Exporte l'arbre en PGN, variantes comprises (entre parenthèses). */
export function toPgn(tree: Tree, headers: Record<string, string> = {}): string {
  const root = tree.nodes[tree.root]!;
  const h: Record<string, string> = { ...headers };
  if (root.fen !== START_FEN) { h.SetUp = "1"; h.FEN = root.fen; }
  const result = h.Result ?? "*";
  const num = (beforeFen: string, force: boolean) => moveNumber(beforeFen, force).replace("…", "...");
  const text = (id: string, force: boolean) => {
    const n = tree.nodes[id]!;
    return num(tree.nodes[n.parent!]!.fen, force) + n.san;
  };
  const line = (parentId: string, force: boolean): string[] => {
    const p = tree.nodes[parentId]!;
    if (!p.children.length) return [];
    const [main, ...vars] = p.children;
    const out = [text(main!, force)];
    for (const v of vars) out.push(`(${[text(v, true), ...line(v, false)].join(" ")})`);
    out.push(...line(main!, vars.length > 0));
    return out;
  };
  const head = Object.entries(h).map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join("\n");
  const body = [...line(tree.root, true), result].join(" ");
  return (head ? head + "\n\n" : "") + body + "\n";
}

export class PgnError extends Error {}

/**
 * Lit un PGN (une partie), variantes comprises ; commentaires { } et ;, annotations $n, !? ignorés.
 * Lève PgnError avec le coup fautif s'il y a un coup illégal.
 */
export function parsePgn(pgn: string): { tree: Tree; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const body = pgn.replace(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm, (_, k: string, v: string) => { headers[k] = v; return ""; });
  let fen = START_FEN;
  if (headers.FEN) {
    try { new Chess(headers.FEN); fen = headers.FEN; } catch { throw new PgnError("FEN de départ invalide"); }
  }
  let tree = newTree(fen);
  let cur = tree.root;
  const stack: string[] = [];
  const tokens = body.match(/\{[^}]*\}|;[^\n]*|\(|\)|\$\d+|1-0|0-1|1\/2-1\/2|\*|\d+\.(?:\.\.)?|…|[^\s(){};]+/g) ?? [];
  for (const raw of tokens) {
    if (raw.startsWith("{") || raw.startsWith(";") || raw.startsWith("$") || raw === "*" || raw === "1-0" || raw === "0-1" || raw === "1/2-1/2" || raw === "…") continue;
    if (/^\d+\.(\.\.)?$/.test(raw)) continue;
    if (raw === "(") {
      stack.push(cur);
      const p = tree.nodes[cur]!.parent;
      if (!p) throw new PgnError("variante mal placée");
      cur = p;
      continue;
    }
    if (raw === ")") {
      const back = stack.pop();
      if (!back) throw new PgnError("parenthèse en trop");
      cur = back;
      continue;
    }
    const san = raw.replace(/^\d+\.+/, "").replace(/[!?]+$/, "").replace(/^0-0-0/, "O-O-O").replace(/^0-0/, "O-O");
    if (!san) continue;
    const c = new Chess(tree.nodes[cur]!.fen);
    let m;
    try { m = c.move(san, { strict: false }); } catch { throw new PgnError(`coup illégal ou illisible : ${raw}`); }
    ({ tree, id: cur } = addMove(tree, cur, { fen: c.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? "") }));
  }
  return { tree, headers };
}

/** FEN valide (position légale) ? */
export function validFen(fen: string): boolean {
  try { new Chess(fen.trim()); return fen.trim().split(/\s+/).length >= 4; } catch { return false; }
}

/** Sauvegarde compacte : uniquement les coups (les positions se recalculent). */
export interface SavedTree { fen: string; moves: SavedMove[]; at: number[] }
type SavedMove = [string, SavedMove[]];

export function saveTree(tree: Tree, current: string): SavedTree {
  const enc = (id: string): SavedMove[] => tree.nodes[id]!.children.map((c) => [tree.nodes[c]!.uci!, enc(c)]);
  // chemin du nœud affiché : index de la suite choisie à chaque étape
  const path = pathTo(tree, current);
  const at = path.slice(1).map((id, i) => tree.nodes[path[i]!]!.children.indexOf(id));
  return { fen: tree.nodes[tree.root]!.fen, moves: enc(tree.root), at };
}

export function loadTree(s: SavedTree): { tree: Tree; current: string } | null {
  if (!s || typeof s.fen !== "string" || !Array.isArray(s.moves) || !validFen(s.fen)) return null;
  let tree = newTree(s.fen);
  const dec = (parent: string, moves: SavedMove[], depth: number) => {
    if (depth > 600) return;
    for (const mv of moves) {
      if (!Array.isArray(mv) || typeof mv[0] !== "string") continue;
      const m = playUci(tree.nodes[parent]!.fen, mv[0]);
      if (!m) continue;
      let id: string;
      ({ tree, id } = addMove(tree, parent, m));
      dec(id, Array.isArray(mv[1]) ? mv[1] : [], depth + 1);
    }
  };
  dec(tree.root, s.moves, 0);
  let current = tree.root;
  for (const i of Array.isArray(s.at) ? s.at : []) {
    const next = tree.nodes[current]!.children[i];
    if (!next) break;
    current = next;
  }
  return { tree, current };
}
