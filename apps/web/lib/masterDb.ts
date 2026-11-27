import { Chess } from "chess.js";
import { pgnMainline, type PgnGameText } from "@chessarena/shared";
import { epdOf } from "./openingBook";

/**
 * Base de parties de maîtres (préparée à partir d'un fichier PGN, par exemple un export ChessBase) :
 * pour chaque position d'ouverture, les coups joués avec leur fréquence, leur score et le niveau des joueurs ;
 * pour chaque ligne des répertoires, des parties modèles à rejouer.
 * Seuls les coups, les noms, les Elo, l'année, le tournoi et le résultat sont gardés : jamais les commentaires.
 *
 * Fichiers produits (public/master/) : meta.json, s/<00..ff>.json (statistiques par position), models/<répertoire>.json.
 */

/** [uci, parties, gains blancs, nulles, gains noirs, Elo moyen (0 si inconnu), dernière année (0 si inconnue)] */
export type MasterStatRow = [string, number, number, number, number, number, number];
export interface MasterMeta { games: number; positions: number; minElo: number; maxPly: number; years: [number, number] | null; builtAt: string; source: string }
export interface MasterGame { w: string; b: string; we: number; be: number; y: number; ev: string; r: "1-0" | "0-1" | "1/2-1/2"; m: string[] }
/** parties modèles d'un répertoire, par nom de ligne */
export type MasterModels = Record<string, MasterGame[]>;

export interface MasterMove { uci: string; san: string; games: number; share: number; white: number; draw: number; black: number; elo: number; year: number }

/** Fichier (parmi 256) qui contient une position : FNV-1a de l'EPD. */
export function shardOf(epd: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < epd.length; i++) { h ^= epd.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h & 0xff).toString(16).padStart(2, "0");
}

// ─── Construction (script) ───────────────────────────────────────────────────

interface Acc { n: number; w: number; d: number; l: number; elo: number; eloN: number; year: number }
export interface ModelTarget { rep: string; line: string; epd: string; ply: number }

export class MasterBuilder {
  readonly stats = new Map<string, Map<string, Acc>>();
  private entries = 0;
  games = 0;
  private years: [number, number] | null = null;
  private readonly targets = new Map<string, ModelTarget[]>();
  private readonly cands = new Map<string, Array<{ score: number; g: MasterGame }>>();
  private readonly maxTargetPly: number;

  constructor(readonly opts: { minElo: number; maxPly: number; minGames: number; models: number; targets?: readonly ModelTarget[]; maxEntries?: number }) {
    for (const t of opts.targets ?? []) { const a = this.targets.get(t.epd) ?? []; a.push(t); this.targets.set(t.epd, a); }
    this.maxTargetPly = Math.max(0, ...(opts.targets ?? []).map((t) => t.ply));
  }

  /** Ajoute une partie ; renvoie false si elle est écartée (niveau, position de départ, résultat, coups illisibles). */
  add(g: PgnGameText): boolean {
    const t = g.tags;
    const r = (t.Result ?? "").trim();
    if (r !== "1-0" && r !== "0-1" && r !== "1/2-1/2") return false;
    if (t.FEN || (t.Variant && !/^(standard|chess)$/i.test(t.Variant))) return false;
    const we = Number(t.WhiteElo) || 0, be = Number(t.BlackElo) || 0;
    // Elo inconnu (parties anciennes) : gardée ; Elo connu sous le seuil : écartée
    if (this.opts.minElo > 0 && ((we && we < this.opts.minElo) || (be && be < this.opts.minElo))) return false;
    const year = Number(/^(\d{4})/.exec(t.Date ?? "")?.[1]) || 0;
    const sans = pgnMainline(g.movetext);
    if (sans.length < 2) return false;
    const c = new Chess();
    const depth = Math.max(this.opts.maxPly, this.maxTargetPly);
    const seen: Array<{ t: ModelTarget }> = [];
    const out: string[] = [];
    for (let i = 0; i < Math.min(sans.length, depth); i++) {
      const before = epdOf(c.fen());
      let m;
      try { m = c.move(sans[i]!); } catch { break; }
      out.push(m.san);
      if (i < this.opts.maxPly) {
        const uci = m.from + m.to + (m.promotion ?? "");
        let pos = this.stats.get(before);
        if (!pos) { pos = new Map(); this.stats.set(before, pos); }
        let a = pos.get(uci);
        if (!a) { a = { n: 0, w: 0, d: 0, l: 0, elo: 0, eloN: 0, year: 0 }; pos.set(uci, a); this.entries++; }
        a.n++;
        if (r === "1-0") a.w++; else if (r === "0-1") a.l++; else a.d++;
        if (we && be) { a.elo += (we + be) / 2; a.eloN++; }
        if (year > a.year) a.year = year;
      }
      for (const tg of this.targets.get(epdOf(c.fen())) ?? []) if (tg.ply === i + 1) seen.push({ t: tg });
    }
    this.games++;
    if (year) this.years = this.years ? [Math.min(this.years[0], year), Math.max(this.years[1], year)] : [year, year];
    if (seen.length) {
      const game: MasterGame = {
        w: (t.White ?? "?").slice(0, 50), b: (t.Black ?? "?").slice(0, 50), we, be, y: year, ev: (t.Event ?? "").replace(/^\?$/, "").slice(0, 60), r,
        m: [...out, ...sans.slice(out.length, 200)],
      };
      // niveau des joueurs, puis parties récentes et décisives (plus instructives)
      const score = (we && be ? (we + be) / 2 : 2000) + (year ? Math.min(year, 2100) - 2000 : 0) * 2 + (r === "1/2-1/2" ? 0 : 30) + Math.min(sans.length, 80) / 4;
      // une ligne peut être atteinte à deux profondeurs (fin de ligne, ou quelques coups avant) : la plus profonde compte
      const best = new Map<string, number>();
      for (const { t: tg } of seen) { const k = `${tg.rep}\u0000${tg.line}`; best.set(k, Math.max(best.get(k) ?? 0, tg.ply)); }
      for (const [k, ply] of best) {
        const list = this.cands.get(k) ?? [];
        list.push({ score: score + ply * 15, g: game });
        list.sort((a, b) => b.score - a.score);
        if (list.length > this.opts.models * 3) list.length = this.opts.models * 3;
        this.cands.set(k, list);
      }
    }
    if (this.opts.maxEntries && this.entries > this.opts.maxEntries) this.prune();
    return true;
  }

  /** Mémoire : on oublie les coups vus une seule fois (les bases énormes). */
  private prune() {
    for (const [k, pos] of this.stats) {
      for (const [u, a] of pos) if (a.n <= 1) { pos.delete(u); this.entries--; }
      if (!pos.size) this.stats.delete(k);
    }
  }

  /** Les fichiers à écrire : chemin relatif → contenu JSON. */
  finish(source: string): Map<string, unknown> {
    const files = new Map<string, unknown>();
    const shards = new Map<string, Record<string, MasterStatRow[]>>();
    let positions = 0;
    for (const [epd, pos] of this.stats) {
      const total = [...pos.values()].reduce((s, a) => s + a.n, 0);
      if (total < this.opts.minGames) continue;
      const rows = [...pos.entries()].filter(([, a]) => a.n >= Math.max(2, Math.ceil(total * 0.01)) || a.n >= this.opts.minGames)
        .sort((x, y) => y[1].n - x[1].n).slice(0, 12)
        .map(([u, a]): MasterStatRow => [u, a.n, a.w, a.d, a.l, a.eloN ? Math.round(a.elo / a.eloN) : 0, a.year]);
      if (!rows.length) continue;
      const sh = shardOf(epd);
      const s = shards.get(sh) ?? {};
      s[epd] = rows;
      shards.set(sh, s);
      positions++;
    }
    for (const [sh, s] of shards) files.set(`s/${sh}.json`, s);
    const models = new Map<string, MasterModels>();
    for (const [k, list] of this.cands) {
      const [rep, line] = k.split("\u0000") as [string, string];
      // des résultats variés : au moins une victoire de chaque camp si possible
      const pick: MasterGame[] = [];
      for (const want of ["1-0", "0-1", "1/2-1/2"]) { const x = list.find((c) => c.g.r === want && !pick.includes(c.g)); if (x && pick.length < this.opts.models) pick.push(x.g); }
      for (const c of list) if (pick.length < this.opts.models && !pick.includes(c.g)) pick.push(c.g);
      pick.sort((a, b) => (b.we + b.be) - (a.we + a.be));
      const m = models.get(rep) ?? {};
      m[line] = pick;
      models.set(rep, m);
    }
    for (const [rep, m] of models) files.set(`models/${rep}.json`, m);
    const meta: MasterMeta = { games: this.games, positions, minElo: this.opts.minElo, maxPly: this.opts.maxPly, years: this.years, builtAt: new Date().toISOString(), source };
    files.set("meta.json", meta);
    return files;
  }
}

// ─── Lecture (navigateur) ────────────────────────────────────────────────────

const cache = new Map<string, Promise<unknown>>();
function getJson<T>(path: string): Promise<T | null> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(`/master/${path}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    cache.set(path, p);
  }
  return p as Promise<T | null>;
}

/** La base est-elle installée ? (null : pas encore) */
export const loadMasterMeta = () => getJson<MasterMeta>("meta.json");

/** Lignes de statistiques → coups lisibles (SAN, part des parties, score). */
export function masterMovesOf(fen: string, rows: readonly MasterStatRow[] | undefined): MasterMove[] {
  if (!rows?.length) return [];
  const total = rows.reduce((s, r) => s + r[1], 0);
  const out: MasterMove[] = [];
  for (const [uci, n, w, d, l, elo, year] of rows) {
    const c = new Chess(fen);
    let san: string;
    try { san = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { continue; }
    out.push({ uci, san, games: n, share: Math.round((100 * n) / total), white: Math.round((100 * w) / n), draw: Math.round((100 * d) / n), black: Math.round((100 * l) / n), elo, year });
  }
  return out;
}

/** Les coups des maîtres dans une position (vide si la base n'est pas installée ou la position inconnue). */
export async function masterMoves(fen: string): Promise<MasterMove[]> {
  if (!(await loadMasterMeta())) return [];
  const epd = epdOf(fen);
  const s = await getJson<Record<string, MasterStatRow[]>>(`s/${shardOf(epd)}.json`);
  return masterMovesOf(fen, s?.[epd]);
}

/** Les parties modèles d'un répertoire (par ligne). */
export async function masterModels(repId: string): Promise<MasterModels | null> {
  if (!(await loadMasterMeta())) return null;
  return getJson<MasterModels>(`models/${repId}.json`);
}

/** Score du point de vue d'une couleur : gains + la moitié des nulles. */
export const scoreFor = (m: Pick<MasterMove, "white" | "draw" | "black">, c: "w" | "b") => Math.round((c === "w" ? m.white : m.black) + m.draw / 2);
