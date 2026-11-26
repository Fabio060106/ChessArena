import { Chess } from "chess.js";
import type { RepertoireGame } from "@chessarena/shared";
import { openingIdea, openingOf } from "./openings";

/**
 * Conseiller d'ouvertures : lit les parties du joueur (site + Lichess), en tire un profil
 * (niveau, style, forces, faiblesses, résultats par ouverture) et propose des ouvertures adaptées
 * pour les Blancs, et pour les Noirs contre 1.e4 et contre 1.d4, en expliquant pourquoi.
 */

export type Slot = "w" | "b-e4" | "b-d4";

export interface OpeningOption {
  id: string;
  name: string;
  slot: Slot;
  /** ligne de base (SAN, depuis la position initiale) */
  moves: string;
  /** 0 = très calme / positionnel … 1 = très tranchant */
  sharp: number;
  /** quantité de théorie à apprendre : 1 faible, 2 moyenne, 3 élevée */
  theory: 1 | 2 | 3;
  /** niveau conseillé à partir de (classement en ligne) */
  minRating: number;
  /** finales et échanges fréquents */
  simplifies: boolean;
  /** solide : peu de risque de perdre vite */
  solid: boolean;
  /** reconnaît la famille dans les noms d'ouverture (Lichess en anglais, site en français) */
  match: RegExp;
  plan: string;
}

export const CATALOG: OpeningOption[] = [
  // ─── Blancs ───
  { id: "italian", name: "Partie italienne (Giuoco Pianissimo)", slot: "w", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3", sharp: 0.35, theory: 1, minRating: 0, simplifies: false, solid: true, match: /italian|italienne|giuoco/i,
    plan: "Développement rapide, roque, puis manœuvre lente (a4, Re1, Nbd2-f1-g3) avant d'ouvrir avec d4 au bon moment." },
  { id: "evans", name: "Gambit Evans", slot: "w", moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", sharp: 0.85, theory: 2, minRating: 1100, simplifies: false, solid: false, match: /evans/i,
    plan: "Un pion sacrifié pour gagner du temps : c3 et d4 construisent un grand centre et le jeu va vite vers le roi noir." },
  { id: "scotch", name: "Partie écossaise", slot: "w", moves: "e4 e5 Nf3 Nc6 d4 exd4 Nxd4", sharp: 0.55, theory: 2, minRating: 1200, simplifies: false, solid: true, match: /scotch|écossaise/i,
    plan: "Le centre s'ouvre dès le 3e coup : pièces actives, jeu clair, peu de pièges à connaître côté blanc." },
  { id: "ruy", name: "Partie espagnole", slot: "w", moves: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", sharp: 0.45, theory: 3, minRating: 1700, simplifies: false, solid: true, match: /ruy lopez|espagnole|spanish/i,
    plan: "Pression durable sur e5, plan c3-d4, longues manœuvres : l'ouverture de référence pour progresser en stratégie." },
  { id: "london", name: "Système de Londres", slot: "w", moves: "d4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3", sharp: 0.2, theory: 1, minRating: 0, simplifies: false, solid: true, match: /london|londres/i,
    plan: "Toujours la même structure (d4, Bf4, e3, c3, Nbd2) : peu de théorie, une position saine, des plans d'attaque simples (Ne5, h4)." },
  { id: "qgambit", name: "Gambit dame", slot: "w", moves: "d4 d5 c4 e6 Nc3 Nf6 Bg5", sharp: 0.35, theory: 2, minRating: 1400, simplifies: false, solid: true, match: /queen'?s gambit|gambit dame/i,
    plan: "Pression sur le centre noir, attaque de minorité (b4-b5) ou jeu central avec e4 : de la stratégie classique." },
  { id: "kgambit", name: "Gambit du roi", slot: "w", moves: "e4 e5 f4", sharp: 0.95, theory: 2, minRating: 1000, simplifies: false, solid: false, match: /king'?s gambit|gambit du roi/i,
    plan: "f4 ouvre la colonne f pour attaquer le roi noir : initiative maximale, risques assumés." },
  { id: "english", name: "Ouverture anglaise", slot: "w", moves: "c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2", sharp: 0.3, theory: 2, minRating: 1700, simplifies: false, solid: true, match: /english|anglaise/i,
    plan: "Contrôle de d5 à distance, fou en fianchetto : un jeu souple qui contourne la théorie des débuts 1.e4 et 1.d4." },
  // ─── Noirs contre 1.e4 ───
  { id: "caro", name: "Défense Caro-Kann", slot: "b-e4", moves: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5", sharp: 0.25, theory: 2, minRating: 0, simplifies: true, solid: true, match: /caro/i,
    plan: "Une structure de pions très solide et un fou de cases blanches actif : on perd rarement vite, et les finales sont souvent bonnes pour les Noirs." },
  { id: "french", name: "Défense française", slot: "b-e4", moves: "e4 e6 d4 d5 Nc3 Nf6", sharp: 0.45, theory: 2, minRating: 1100, simplifies: false, solid: true, match: /french|française/i,
    plan: "Chaîne de pions solide, puis contre-attaque du centre blanc par …c5 et …f6." },
  { id: "e5", name: "1…e5 (jeu ouvert classique)", slot: "b-e4", moves: "e4 e5 Nf3 Nc6", sharp: 0.45, theory: 2, minRating: 0, simplifies: false, solid: true, match: /^(?!.*sicilian)(italian|ruy|scotch|four knights|petrov|russian|philidor|king'?s gambit|vienna|bishop'?s opening|ponziani|two knights|partie|défense des deux|défense russe)/i,
    plan: "Les principes à l'état pur : développement, centre, roque. Prépare surtout l'Italienne et l'Espagnole." },
  { id: "sicilian", name: "Défense sicilienne (Najdorf)", slot: "b-e4", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", sharp: 0.85, theory: 3, minRating: 1700, simplifies: false, solid: false, match: /sicilian|sicilienne/i,
    plan: "La défense la plus combative : positions déséquilibrées, attaques sur les deux ailes, beaucoup de calcul." },
  { id: "dragon", name: "Sicilienne Dragon", slot: "b-e4", moves: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6", sharp: 0.9, theory: 2, minRating: 1400, simplifies: false, solid: false, match: /dragon/i,
    plan: "Fou en g7 sur la grande diagonale et contre-attaque sur l'aile dame : une course à l'attaque." },
  { id: "scandi", name: "Défense scandinave", slot: "b-e4", moves: "e4 d5 exd5 Qxd5 Nc3 Qa5", sharp: 0.4, theory: 1, minRating: 0, simplifies: false, solid: true, match: /scandinavian|scandinave/i,
    plan: "On impose son jeu dès le premier coup, avec une structure simple et peu de théorie." },
  // ─── Noirs contre 1.d4 ───
  { id: "qgd", name: "Gambit dame refusé", slot: "b-d4", moves: "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7", sharp: 0.25, theory: 2, minRating: 0, simplifies: true, solid: true, match: /queen'?s gambit declined|gambit dame refusé/i,
    plan: "Le centre d5 tient, développement naturel, égalisation sûre : l'arme des joueurs solides." },
  { id: "slav", name: "Défense slave", slot: "b-d4", moves: "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4", sharp: 0.35, theory: 2, minRating: 1200, simplifies: false, solid: true, match: /slav/i,
    plan: "Comme la Caro-Kann contre 1.d4 : structure solide, fou de cases blanches libre." },
  { id: "kid", name: "Défense est-indienne", slot: "b-d4", moves: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O", sharp: 0.85, theory: 3, minRating: 1600, simplifies: false, solid: false, match: /king'?s indian|est-indienne/i,
    plan: "On laisse le centre aux Blancs pour l'attaquer ensuite par …e5 et une attaque de pions sur l'aile roi." },
  { id: "nimzo", name: "Défense nimzo-indienne", slot: "b-d4", moves: "d4 Nf6 c4 e6 Nc3 Bb4", sharp: 0.5, theory: 3, minRating: 1700, simplifies: false, solid: true, match: /nimzo/i,
    plan: "Clouage du cavalier c3, lutte pour e4, souvent la paire de fous contre une meilleure structure." },
  { id: "dutch", name: "Défense hollandaise", slot: "b-d4", moves: "d4 f5 c4 Nf6 g3 e6 Bg2 Be7", sharp: 0.75, theory: 2, minRating: 1300, simplifies: false, solid: false, match: /dutch|hollandaise/i,
    plan: "…f5 contrôle e4 et prépare une attaque à l'aile roi : un jeu combatif contre 1.d4." },
  { id: "londonb", name: "Mise en place simple (…d5, …Nf6, …c6, …Bf5)", slot: "b-d4", moves: "d4 d5 Nf3 Nf6 c4 c6", sharp: 0.2, theory: 1, minRating: 0, simplifies: false, solid: true, match: /^$/,
    plan: "Une mise en place simple (…d5, …Nf6, …c6, …Bf5, …e6) qui marche contre presque tout." },
];

// ─── Profil du joueur ────────────────────────────────────────────────────────

export interface FamilyStat { name: string; color: "w" | "b"; games: number; score: number; /** premier coup des Blancs */ first: string }
export interface PlayerProfile {
  games: number;
  rating: number | null;
  level: string;
  /** 0 = très positionnel … 1 = très tactique */
  sharp: number;
  style: string;
  score: { w: number | null; b: number | null };
  vsE4: { games: number; score: number | null };
  vsD4: { games: number; score: number | null };
  /** parties perdues en moins de 25 coups / toutes les défaites */
  quickLosses: number;
  /** score dans les parties longues (60 coups et plus), null si trop peu */
  longScore: number | null;
  families: FamilyStat[];
  strengths: string[];
  weaknesses: string[];
  firstMove: string | null;
}

const PTS = { win: 1, draw: 0.5, loss: 0 } as const;
const pct = (pts: number, n: number) => (n ? Math.round((100 * pts) / n) : null);

/** Famille d'ouverture : nom Lichess (avant « : »), sinon nom reconnu par le site. */
function family(headers: Record<string, string>, sans: string[]): string | null {
  const o = headers.Opening?.split(":")[0]?.trim();
  if (o && o !== "?") return o;
  return openingOf(sans).name?.split(",")[0] ?? null;
}

interface GameFacts { color: "w" | "b"; outcome: "win" | "loss" | "draw"; plies: number; sans: string[]; family: string | null; rating: number | null; at: string; aggr: number; queensOffEarly: boolean; opposite: boolean }

function factsOf(g: RepertoireGame): GameFacts | null {
  const c = new Chess();
  try { c.loadPgn(g.pgn); } catch { return null; }
  const sans = c.history();
  if (sans.length < 2) return null;
  const h = c.getHeaders() as Record<string, string>;
  const rating = Number(g.color === "w" ? h.WhiteElo : h.BlackElo);
  // agressivité : prises et échecs du joueur dans les 30 premiers coups ; dames échangées tôt ; roques opposés
  const mine = sans.slice(0, 60).filter((_, i) => (i % 2 === 0) === (g.color === "w"));
  const aggr = mine.filter((s) => s.includes("x") || s.includes("+")).length / Math.max(1, mine.length);
  const b = new Chess();
  let queensOffEarly = false;
  for (let i = 0; i < Math.min(sans.length, 50); i++) {
    b.move(sans[i]!);
    if (i >= 6 && !b.board().flat().some((p) => p?.type === "q")) { queensOffEarly = true; break; }
  }
  const ck = (col: "w" | "b") => sans.findIndex((s, i) => (i % 2 === 0) === (col === "w") && s.startsWith("O-O"));
  const wk = ck("w"), bk = ck("b");
  const opposite = wk >= 0 && bk >= 0 && sans[wk]!.startsWith("O-O-O") !== sans[bk]!.startsWith("O-O-O");
  return { color: g.color, outcome: g.outcome, plies: sans.length, sans, family: family(h, sans), rating: Number.isFinite(rating) && rating > 0 ? rating : null, at: g.endedAt, aggr, queensOffEarly, opposite };
}

export function levelOf(r: number | null): string {
  if (r === null) return "à déterminer";
  if (r < 1200) return "débutant";
  if (r < 1500) return "intermédiaire";
  if (r < 1800) return "confirmé";
  if (r < 2100) return "fort joueur de club";
  return "expert";
}

export function buildProfile(games: readonly RepertoireGame[]): PlayerProfile {
  const fs = games.map(factsOf).filter((x): x is GameFacts => !!x);
  const n = fs.length;
  const recent = [...fs].sort((a, b) => b.at.localeCompare(a.at)).filter((f) => f.rating).slice(0, 50);
  const rating = recent.length ? Math.round(recent.reduce((s, f) => s + f.rating!, 0) / recent.length) : null;
  const sum = (xs: GameFacts[]) => xs.reduce((s, f) => s + PTS[f.outcome], 0);
  const W = fs.filter((f) => f.color === "w"), B = fs.filter((f) => f.color === "b");
  const vsE4 = B.filter((f) => f.sans[0] === "e4"), vsD4 = B.filter((f) => f.sans[0] === "d4");
  const losses = fs.filter((f) => f.outcome === "loss");
  const quickLosses = losses.length ? losses.filter((f) => f.plies <= 50).length / losses.length : 0;
  const long = fs.filter((f) => f.plies >= 120);
  const decisive = n ? fs.filter((f) => f.outcome !== "draw").length / n : 0;
  const aggr = n ? fs.reduce((s, f) => s + f.aggr, 0) / n : 0;
  const qOff = n ? fs.filter((f) => f.queensOffEarly).length / n : 0;
  const opp = n ? fs.filter((f) => f.opposite).length / n : 0;
  // style : agressivité (prises/échecs), parties décisives, roques opposés ; les échanges de dames précoces tirent vers le positionnel
  const sharp = Math.max(0, Math.min(1, 0.5 + (aggr - 0.22) * 2.2 + (decisive - 0.85) * 0.8 + opp * 0.6 - qOff * 0.8));
  const style = sharp >= 0.62 ? "tactique et offensif" : sharp <= 0.4 ? "positionnel et solide" : "polyvalent";
  const fam = new Map<string, FamilyStat & { pts: number }>();
  for (const f of fs) {
    if (!f.family) continue;
    const k = `${f.color}|${f.sans[0]}|${f.family}`;
    const e = fam.get(k) ?? { name: f.family, color: f.color, first: f.sans[0]!, games: 0, score: 0, pts: 0 };
    e.games++; e.pts += PTS[f.outcome]; fam.set(k, e);
  }
  const families = [...fam.values()].map(({ pts, ...e }) => ({ ...e, score: Math.round((100 * pts) / e.games) })).sort((a, b) => b.games - a.games);
  const first = new Map<string, number>();
  for (const f of W) first.set(f.sans[0]!, (first.get(f.sans[0]!) ?? 0) + 1);
  const firstMove = [...first.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const p: PlayerProfile = {
    games: n, rating, level: levelOf(rating), sharp, style,
    score: { w: pct(sum(W), W.length), b: pct(sum(B), B.length) },
    vsE4: { games: vsE4.length, score: pct(sum(vsE4), vsE4.length) },
    vsD4: { games: vsD4.length, score: pct(sum(vsD4), vsD4.length) },
    quickLosses, longScore: long.length >= 5 ? pct(sum(long), long.length) : null,
    families, strengths: [], weaknesses: [], firstMove,
  };
  // forces et faiblesses, en phrases
  const good = families.filter((f) => f.games >= 4 && f.score >= 58).sort((a, b) => b.score - a.score);
  const bad = families.filter((f) => f.games >= 4 && f.score <= 42).sort((a, b) => a.score - b.score);
  const side = (c: "w" | "b") => (c === "w" ? "avec les Blancs" : "avec les Noirs");
  for (const f of good.slice(0, 2)) p.strengths.push(`Parties en ${f.name}, ${side(f.color)} : ${f.score} % sur ${f.games} parties.`);
  for (const f of bad.slice(0, 2)) p.weaknesses.push(`Parties en ${f.name}, ${side(f.color)} : seulement ${f.score} % sur ${f.games} parties.`);
  if (p.score.w !== null && p.score.b !== null && W.length >= 5 && B.length >= 5) {
    if (p.score.w - p.score.b >= 12) p.weaknesses.push(`Tu marques nettement moins avec les Noirs (${p.score.b} %) qu'avec les Blancs (${p.score.w} %).`);
    else if (p.score.b - p.score.w >= 12) p.weaknesses.push(`Tu marques moins avec les Blancs (${p.score.w} %) qu'avec les Noirs (${p.score.b} %).`);
  }
  if (losses.length >= 5 && quickLosses >= 0.4) p.weaknesses.push(`${Math.round(quickLosses * 100)} % de tes défaites arrivent avant le 25e coup : l'ouverture et la tactique du début de partie coûtent cher.`);
  else if (losses.length >= 5 && quickLosses <= 0.15) p.strengths.push("Tu perds rarement vite : tes débuts de partie sont solides.");
  if (p.longScore !== null && p.longScore >= 58) p.strengths.push(`Tu es bon dans les parties longues (${p.longScore} % au-delà de 60 coups) : la finale est un point fort.`);
  if (p.longScore !== null && p.longScore <= 42) p.weaknesses.push(`Les parties longues te réussissent moins (${p.longScore} % au-delà de 60 coups) : la finale est à travailler.`);
  if (sharp >= 0.62) p.strengths.push("Tu cherches l'initiative : beaucoup de prises, d'échecs et de parties décisives.");
  if (sharp <= 0.4) p.strengths.push("Tu joues des positions calmes et tu acceptes volontiers les échanges.");
  return p;
}

// ─── Recommandations ─────────────────────────────────────────────────────────

export interface Advice { option: OpeningOption; score: number; reasons: string[]; current: FamilyStat | null; idea: string | null }

export function recommend(p: PlayerProfile, slot: Slot, n = 2): Advice[] {
  const r = p.rating ?? 1500;
  const color = slot === "w" ? "w" : "b";
  const out: Advice[] = [];
  for (const o of CATALOG.filter((x) => x.slot === slot)) {
    let s = 0;
    const why: string[] = [];
    // niveau
    if (r < o.minRating) { s -= (o.minRating - r) / 150; }
    else if (o.theory === 1 && r < 1600) { s += 0.6; why.push("peu de théorie à apprendre : idéal à ton niveau"); }
    if (o.theory === 3 && r >= 1800) { s += 0.4; why.push("ouverture riche, adaptée à ton niveau"); }
    if (o.theory === 3 && r < 1600) s -= 1;
    // style
    const d = Math.abs(o.sharp - p.sharp);
    s -= d * 3;
    if (d < 0.2) why.push(p.sharp >= 0.62 ? "colle à ton style offensif" : p.sharp <= 0.4 ? "colle à ton style positionnel" : "convient à ton jeu polyvalent");
    // faiblesses
    if (p.quickLosses >= 0.4) {
      if (o.solid) { s += 0.8; why.push("solide : limite les défaites rapides"); }
      else s -= 1;
    }
    if (p.longScore !== null && p.longScore <= 42 && o.simplifies) s -= 0.8;
    if (p.longScore !== null && p.longScore >= 58 && o.simplifies) { s += 0.7; why.push("mène souvent à des finales, ton point fort"); }
    // ce que le joueur joue déjà
    const cur = p.families.find((f) => f.color === color && o.match.test(f.name) && (slot === "w" || f.first === (slot === "b-e4" ? "e4" : "d4"))) ?? null;
    if (cur && cur.games >= 4) {
      if (cur.score >= 55) { s += 2; why.unshift(`tu la joues déjà avec succès (${cur.score} % sur ${cur.games} parties) : garde-la et approfondis-la`); }
      else if (cur.score <= 40) { s -= 1.5; }
      else { s += 0.5; why.push(`tu la connais déjà (${cur.games} parties)`); }
    }
    if (slot === "w" && p.firstMove && o.moves.startsWith(p.firstMove)) { s += 0.4; why.push(`commence par 1.${p.firstMove}, ton premier coup habituel`); }
    out.push({ option: o, score: s, reasons: why.slice(0, 3), current: cur, idea: openingIdea(o.name.replace(/ \(.*\)$/, "")) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

/** Coups UCI d'une ligne SAN (pour l'ouvrir sur l'échiquier d'analyse). */
export function ucisOf(moves: string): string[] {
  const c = new Chess();
  const out: string[] = [];
  for (const s of moves.split(" ")) { const m = c.move(s); out.push(m.from + m.to + (m.promotion ?? "")); }
  return out;
}
