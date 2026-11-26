import { Chess, type Square } from "chess.js";
import { scoreToCp, type Score } from "./engine";

/**
 * Vocabulaire d'échecs pour les commentaires « comme dans un livre » : ce que fait un coup
 * (développement, centre, roque, menace, fourchette, colonne ouverte, pion passé…),
 * l'évaluation en mots, la phase de la partie.
 */

export const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAME: Record<string, string> = { p: "le pion", n: "le cavalier", b: "le fou", r: "la tour", q: "la dame", k: "le roi" };
const SHORT: Record<string, string> = { p: "pion", n: "cavalier", b: "fou", r: "tour", q: "dame", k: "roi" };
export const SIDE = { w: "les Blancs", b: "les Noirs" } as const;
export const SIDE_CAP = { w: "Les Blancs", b: "Les Noirs" } as const;
const OF_SIDE = { w: "des Blancs", b: "des Noirs" } as const;
const TO_SIDE = { w: "aux Blancs", b: "aux Noirs" } as const;
const opp = (c: "w" | "b"): "w" | "b" => (c === "w" ? "b" : "w");

export interface Target { square: string; piece: string; value: number; defended: boolean }

export interface MoveFacts {
  san: string;
  color: "w" | "b";
  piece: string;
  from: string;
  to: string;
  captured: string | null;
  check: boolean;
  mate: boolean;
  castle: "k" | "q" | null;
  promotion: string | null;
  /** pièces adverses attaquées par la pièce jouée, et dignes d'intérêt (plus chères, ou non défendues) */
  targets: Target[];
  /** la pièce jouée était attaquée avant le coup (et pas assez défendue) : elle se met à l'abri */
  escapes: boolean;
  recapture: boolean;
  develops: boolean;
  center: boolean;
  fianchetto: boolean;
  openFile: "open" | "half" | null;
  passed: boolean;
  pawnBreak: boolean;
  queenTrade: boolean;
  kingActive: boolean;
  endgame: boolean;
}

/** La pièce sur `sq` est-elle défendue par son camp ? */
function defended(c: Chess, sq: Square, color: "w" | "b"): boolean {
  return c.attackers(sq, color).length > 0;
}

/** Valeur des pièces (sans les pions ni le roi) d'un camp. */
export function pieceMaterial(fen: string, color: "w" | "b"): number {
  let v = 0;
  for (const row of new Chess(fen).board()) for (const p of row) if (p && p.color === color && p.type !== "p") v += VALUE[p.type]!;
  return v;
}

export function isEndgame(fen: string): boolean {
  const w = pieceMaterial(fen, "w"), b = pieceMaterial(fen, "b");
  return w + b <= 26 || (w <= 13 && b <= 13);
}

function isPassed(c: Chess, sq: string, color: "w" | "b"): boolean {
  const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]);
  for (const row of c.board()) for (const p of row) {
    if (!p || p.type !== "p" || p.color === color) continue;
    const f = p.square.charCodeAt(0) - 97, r = Number(p.square[1]);
    if (Math.abs(f - file) <= 1 && (color === "w" ? r > rank : r < rank)) return false;
  }
  return true;
}

function fileState(c: Chess, file: string, color: "w" | "b"): "open" | "half" | null {
  let own = false, theirs = false;
  for (const row of c.board()) for (const p of row) if (p?.type === "p" && p.square[0] === file) { if (p.color === color) own = true; else theirs = true; }
  return own ? null : theirs ? "half" : "open";
}

/** Ce que fait un coup, d'après la position (sans moteur). `prevTo` : case d'arrivée du coup précédent. */
export function moveFacts(fen: string, uci: string, ply: number, prevTo?: string | null): MoveFacts | null {
  let c: Chess;
  let m;
  try {
    c = new Chess(fen);
    m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch { return null; }
  const before = new Chess(fen);
  const color = m.color as "w" | "b";
  const them = opp(color);
  const endgame = isEndgame(fen);
  // était-elle menacée ? (attaquée par une pièce moins chère, ou attaquée et non défendue)
  const attackersBefore = before.attackers(m.from as Square, them);
  const escapes = m.piece !== "k" && attackersBefore.length > 0 && !m.captured && (
    !defended(before, m.from as Square, color) ||
    attackersBefore.some((s) => VALUE[before.get(s as Square)!.type]! < VALUE[m.piece]!)
  );
  // menaces de la pièce jouée dans la nouvelle position
  const targets: Target[] = [];
  if (!c.isCheckmate()) {
    for (const row of c.board()) for (const p of row) {
      if (!p || p.color !== them || p.type === "k" || p.type === "p" && VALUE[m.piece]! > 1) continue;
      if (!c.attackers(p.square, color).includes(m.to as Square)) continue;
      const def = defended(c, p.square, them);
      if (VALUE[p.type]! > VALUE[m.piece]! || !def) targets.push({ square: p.square, piece: p.type, value: VALUE[p.type]!, defended: def });
    }
  }
  targets.sort((a, b) => b.value - a.value);
  const homeRank = color === "w" ? "1" : "8";
  const isPawn = m.piece === "p";
  return {
    san: m.san, color, piece: m.piece, from: m.from, to: m.to,
    captured: m.captured ?? null,
    check: c.inCheck(), mate: c.isCheckmate(),
    castle: m.isKingsideCastle() ? "k" : m.isQueensideCastle() ? "q" : null,
    promotion: m.promotion ?? null,
    targets, escapes,
    recapture: !!m.captured && prevTo === m.to,
    develops: (m.piece === "n" || m.piece === "b") && m.from[1] === homeRank && ply <= 30,
    center: isPawn && ["d4", "e4", "d5", "e5"].includes(m.to) && ply <= 24,
    fianchetto: m.piece === "b" && m.from[1] === homeRank && ["g2", "b2", "g7", "b7"].includes(m.to),
    openFile: m.piece === "r" && m.from[0] !== m.to[0] ? fileState(c, m.to[0]!, color) : null,
    passed: isPawn && !m.captured && isPassed(c, m.to, color) && (endgame || ply > 40),
    pawnBreak: isPawn && !m.captured && ply > 12 && (["a", "b", "c", "d", "e", "f", "g", "h"].some((f) => {
      const r = Number(m.to[1]) + (color === "w" ? 1 : -1);
      const sq = `${f}${r}`;
      return Math.abs(f.charCodeAt(0) - m.to.charCodeAt(0)) === 1 && c.get(sq as Square)?.type === "p" && c.get(sq as Square)?.color === them;
    })),
    queenTrade: m.captured === "q" && m.piece === "q",
    kingActive: m.piece === "k" && !m.isKingsideCastle() && !m.isQueensideCastle() && endgame,
    endgame,
  };
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} et ${xs.at(-1)}`);

/** L'idée d'un coup en une ou deux phrases (« Développe le cavalier vers le centre et menace le pion e5. »). */
export function ideaOf(f: MoveFacts, opening = false): string {
  const s: string[] = [];
  const who = SIDE_CAP[f.color];
  if (f.mate) return "Échec et mat !";
  if (f.castle) s.push(`${who} roquent ${f.castle === "k" ? "côté roi" : "côté dame"} : le roi est mis à l'abri et la tour entre dans le jeu`);
  else if (f.promotion) s.push(`Le pion arrive au bout et devient ${NAME[f.promotion]}`);
  else if (f.queenTrade) s.push("Échange des dames : la partie se simplifie et la pièce la plus dangereuse disparaît");
  else if (f.recapture) s.push(`Reprise en ${f.to}, le matériel est rétabli`);
  else if (f.captured) s.push(f.piece === "p" && f.captured === "p" ? `Le pion prend en ${f.to}` : `${cap(NAME[f.piece]!)} prend ${NAME[f.captured]} en ${f.to}`);
  else if (f.develops && f.fianchetto) s.push(`Fianchetto : le fou s'installe en ${f.to} et contrôle la grande diagonale`);
  else if (f.develops) s.push(`Développement ${f.piece === "n" ? "du cavalier" : "du fou"} en ${f.to}${["c3", "d3", "e3", "f3", "c6", "d6", "e6", "f6", "c4", "f4", "c5", "f5", "d4", "e4", "d5", "e5"].includes(f.to) ? ", vers le centre" : ""}`);
  else if (f.center) s.push(`Le pion occupe le centre en ${f.to}`);
  else if (f.escapes) s.push(`${cap(NAME[f.piece]!)} attaqué${f.piece === "q" || f.piece === "r" ? "e" : ""} se met à l'abri en ${f.to}`);
  else if (f.openFile) s.push(`La tour prend la colonne ${f.openFile === "open" ? "ouverte" : "semi-ouverte"} ${f.to[0]}`);
  else if (f.passed) s.push(`Le pion passé avance en ${f.to} : chaque case le rapproche de la promotion`);
  else if (f.kingActive) s.push(`En finale le roi devient une pièce d'attaque : il se rapproche du centre et des pions`);
  else if (f.pawnBreak) s.push(`Rupture de pion en ${f.to} : on attaque la chaîne de pions adverse pour ouvrir le jeu`);
  else if (opening && f.piece === "p") s.push(`Coup de pion en ${f.to} qui prépare la sortie des pièces`);
  // menaces créées
  const big = f.targets.filter((t) => t.value >= 3);
  if (f.check && big.length) s.push(`échec, et en même temps ${NAME[f.piece]} attaque ${NAME[big[0]!.piece]} en ${big[0]!.square} : une fourchette`);
  else if (big.length >= 2) s.push(`fourchette : ${NAME[f.piece]} attaque à la fois ${list(big.slice(0, 2).map((t) => `${NAME[t.piece]} en ${t.square}`))}`);
  else if (f.check) s.push("avec échec, ce qui force la réponse");
  else if (f.targets[0]) s.push(`menace ${NAME[f.targets[0].piece]} en ${f.targets[0].square}${f.targets[0].defended ? "" : ", qui n'est pas défendu" + (["q", "r"].includes(f.targets[0].piece) ? "e" : "")}`);
  if (!s.length) return "";
  const out = s.length === 1 ? s[0]! : `${s[0]}, ${s.slice(1).join(", ")}`;
  return cap(out) + ".";
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** Phrase courte qui décrit un coup recommandé (« Nf5, qui menaçait la dame en d6 »). */
export function shortIdea(f: MoveFacts): string {
  if (f.mate) return "qui donnait mat";
  if (f.captured) return `qui prenait ${NAME[f.captured]} en ${f.to}`;
  const big = f.targets.filter((t) => t.value >= 3);
  if (big.length >= 2) return `qui attaquait à la fois ${list(big.slice(0, 2).map((t) => NAME[t.piece]!))}`;
  if (f.targets[0]) return `qui menaçait ${NAME[f.targets[0].piece]} en ${f.targets[0].square}`;
  if (f.check) return "avec échec";
  if (f.castle) return "pour mettre le roi à l'abri";
  if (f.develops) return `pour développer ${NAME[f.piece]}`;
  if (f.escapes) return `pour sauver ${NAME[f.piece]}`;
  if (f.passed) return "pour pousser le pion passé";
  if (f.openFile) return `pour prendre la colonne ${f.to[0]}`;
  if (f.center) return "pour prendre le centre";
  return "";
}

/** L'évaluation en mots (point de vue des Blancs pour le score). */
export function evalWords(s: Score): string {
  if (s.mate !== null && s.mate !== 0) return `${s.mate > 0 ? "les Blancs" : "les Noirs"} ont un mat forcé en ${Math.abs(s.mate)}`;
  const cp = scoreToCp(s);
  const side = cp > 0 ? "les Blancs" : "les Noirs";
  const a = Math.abs(cp);
  if (a < 35) return "la position est équilibrée";
  if (a < 90) return `${side} ont un léger avantage`;
  if (a < 200) return `${side} ont un net avantage`;
  if (a < 450) return `${side} ont un avantage décisif`;
  return `${side} sont en train de gagner`;
}

export function pieceList(fen: string, color: "w" | "b"): string {
  const n: Record<string, number> = {};
  for (const row of new Chess(fen).board()) for (const p of row) if (p && p.color === color && p.type !== "k") n[p.type] = (n[p.type] ?? 0) + 1;
  const part = (t: string) => (n[t] ? `${n[t]} ${SHORT[t]}${n[t]! > 1 ? "s" : ""}` : "");
  return ["q", "r", "b", "n", "p"].map(part).filter(Boolean).join(", ") || "le roi seul";
}

export { OF_SIDE, TO_SIDE, opp, list, cap };
