import { Chess } from "chess.js";

/**
 * Stockfish 19 (stockfish.js, version « lite » mono-thread, ~1,9 Mo) dans un Web Worker.
 * Réservé à la relecture des parties TERMINÉES (page « Mes parties ») : jamais chargé pendant une partie.
 */
export const ENGINE_URL = "/stockfish/stockfish-19-lite-single.js";
export const ENGINE_NAME = "Stockfish 19";

/** Évaluation du point de vue des Blancs : centipions, ou mat en N (positif = les Blancs matent). */
export interface Score { cp: number | null; mate: number | null }
export interface EngineLine { depth: number; score: Score; pv: string[] }

/** Analyse d'une ligne « info » UCI (toutes les lignes MultiPV) ; le score est ramené au point de vue des Blancs. */
export function parseInfoN(line: string, turn: "w" | "b"): (EngineLine & { multipv: number }) | null {
  if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
  const depth = Number(/ depth (\d+)/.exec(line)?.[1]);
  const cp = / score cp (-?\d+)/.exec(line)?.[1];
  const mate = / score mate (-?\d+)/.exec(line)?.[1];
  if (!depth || (cp === undefined && mate === undefined)) return null;
  if (/ (lowerbound|upperbound)/.test(line)) return null; // borne provisoire : pas une évaluation
  const sign = turn === "w" ? 1 : -1;
  return {
    depth,
    multipv: Number(/ multipv (\d+)/.exec(line)?.[1] ?? 1),
    score: { cp: cp !== undefined ? sign * Number(cp) : null, mate: mate !== undefined ? sign * Number(mate) : null },
    pv: line.split(" pv ")[1]!.trim().split(/\s+/),
  };
}

/** Meilleure ligne seulement (MultiPV 1). */
export function parseInfo(line: string, turn: "w" | "b"): EngineLine | null {
  const r = parseInfoN(line, turn);
  if (!r || r.multipv !== 1) return null;
  return { depth: r.depth, score: r.score, pv: r.pv };
}

/** Score pour la barre et les calculs : un mat compte comme ±100 pions. */
export function scoreToCp(s: Score): number {
  if (s.mate !== null) return s.mate === 0 ? 0 : Math.sign(s.mate) * 10_000;
  return s.cp ?? 0;
}

/** « +1,4 », « −0,3 », « M3 », « −M2 » (point de vue des Blancs). */
export function formatScore(s: Score): string {
  if (s.mate !== null) return `${s.mate < 0 ? "−" : ""}M${Math.abs(s.mate)}`;
  if (s.cp !== null && Math.abs(s.cp) >= 10_000) return s.cp > 0 ? "1-0" : "0-1"; // mat sur l'échiquier
  const v = (s.cp ?? 0) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1).replace(".", ",")}`;
}

/** Chances de gain (0–100) des Blancs selon l'évaluation — même courbe que Lichess. */
export function winPct(cp: number): number {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export type MoveMark = "??" | "?" | "?!" | null;

/** Qualité d'un coup d'après la perte de chances de gain du joueur qui l'a joué (seuils Lichess : 10 / 20 / 30 %). */
export function classify(before: number, after: number, mover: "w" | "b"): MoveMark {
  const loss = mover === "w" ? winPct(before) - winPct(after) : winPct(after) - winPct(before);
  if (loss >= 30) return "??";
  if (loss >= 20) return "?";
  if (loss >= 10) return "?!";
  return null;
}

/** Précision moyenne (0–100) façon Lichess, à partir des pertes de chances de gain. */
export function accuracy(evals: number[], mover: "w" | "b"): number | null {
  const acc: number[] = [];
  for (let i = 1; i < evals.length; i++) {
    const moverOf = i % 2 === 1 ? "w" : "b"; // le demi-coup i (1 = premier coup blanc)
    if (moverOf !== mover) continue;
    const before = winPct(evals[i - 1]!); const after = winPct(evals[i]!);
    const loss = Math.max(0, mover === "w" ? before - after : after - before);
    acc.push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)));
  }
  return acc.length ? Math.round(acc.reduce((a, b) => a + b, 0) / acc.length) : null;
}

/** Précision (0–100) d'une liste de coups (évaluation avant / après, joueur) : même formule, tout point de départ. */
export function accuracyOf(moves: ReadonlyArray<{ before: number; after: number; mover: "w" | "b" }>): number | null {
  if (!moves.length) return null;
  const acc = moves.map(({ before, after, mover }) => {
    const loss = Math.max(0, mover === "w" ? winPct(before) - winPct(after) : winPct(after) - winPct(before));
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
  });
  return Math.round(acc.reduce((a, b) => a + b, 0) / acc.length);
}

/** Ligne principale lisible (SAN), limitée à `max` demi-coups. */
export function pvToSan(fen: string, pv: string[], max = 8): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
  }
  return out;
}

interface Job {
  fen: string; depth: number; multiPv: number;
  onInfo?: (l: EngineLine) => void;
  onLines?: (lines: EngineLine[]) => void;
  resolve: (l: EngineLine | null) => void;
}

/** Un moteur, une recherche à la fois ; une nouvelle demande interrompt la précédente (stop). */
export class Engine {
  private w: Worker;
  private ready: Promise<void>;
  private cur: Job | null = null;
  private next: Job | null = null;
  private best: EngineLine | null = null;
  private lines: EngineLine[] = [];
  private mpv = 1;

  constructor(url = ENGINE_URL) {
    this.w = new Worker(url);
    let ok!: () => void;
    this.ready = new Promise((r) => (ok = r));
    this.w.onmessage = (e: MessageEvent<string>) => {
      const line = String(e.data);
      if (line === "uciok" || line === "readyok") return ok();
      const job = this.cur;
      if (!job) return;
      if (line.startsWith("bestmove")) {
        this.cur = null;
        job.resolve(this.best);
        this.best = null;
        void this.pump();
        return;
      }
      const info = parseInfoN(line, job.fen.split(" ")[1] === "b" ? "b" : "w");
      if (!info) return;
      const l: EngineLine = { depth: info.depth, score: info.score, pv: info.pv };
      if (info.multipv === 1) {
        this.best = l;
        job.onInfo?.(l);
        // nouvelle profondeur : les autres lignes seront remplacées au fur et à mesure
        this.lines = [l, ...this.lines.slice(1).filter((x) => x.depth >= l.depth - 1)];
      } else {
        this.lines[info.multipv - 1] = l;
      }
      if (job.onLines) job.onLines(this.lines.filter(Boolean).slice(0, job.multiPv));
    };
    this.w.postMessage("uci");
    this.w.postMessage("setoption name Hash value 32");
  }

  /** Analyse `fen` jusqu'à `depth` ; résout avec la meilleure ligne (ou null si interrompue par une autre demande). */
  analyse(fen: string, depth: number, onInfo?: (l: EngineLine) => void): Promise<EngineLine | null> {
    return this.enqueue({ fen, depth, multiPv: 1, onInfo });
  }

  /** Plusieurs meilleures suites (MultiPV) : `onLines` reçoit les lignes triées, la meilleure d'abord. */
  analyseLines(fen: string, depth: number, multiPv: number, onLines: (lines: EngineLine[]) => void): Promise<EngineLine | null> {
    return this.enqueue({ fen, depth, multiPv: Math.max(1, Math.min(5, multiPv)), onLines });
  }

  private enqueue(j: Omit<Job, "resolve">): Promise<EngineLine | null> {
    return new Promise((resolve) => {
      if (this.next) this.next.resolve(null);
      this.next = { ...j, resolve };
      if (this.cur) { this.cur.onInfo = undefined; this.cur.onLines = undefined; this.w.postMessage("stop"); }
      else void this.pump();
    });
  }

  private async pump() {
    await this.ready;
    if (this.cur || !this.next) return;
    const job = this.next; this.next = null; this.cur = job; this.best = null; this.lines = [];
    if (new Chess(job.fen).isGameOver()) { this.cur = null; job.resolve(null); return void this.pump(); }
    if (job.multiPv !== this.mpv) { this.w.postMessage(`setoption name MultiPV value ${job.multiPv}`); this.mpv = job.multiPv; }
    this.w.postMessage(`position fen ${job.fen}`);
    this.w.postMessage(`go depth ${job.depth}`);
  }

  /** Force de jeu (0 = très faible … 20 = maximum) : pour jouer contre l'ordinateur. */
  setSkill(level: number) {
    void this.ready.then(() => this.w.postMessage(`setoption name Skill Level value ${Math.max(0, Math.min(20, Math.round(level)))}`));
  }

  stop() { if (this.next) { this.next.resolve(null); this.next = null; } if (this.cur) this.w.postMessage("stop"); }
  terminate() { this.stop(); this.w.terminate(); }
}

/** Évaluation (point de vue des Blancs) d'une position terminale, sans moteur. */
export function terminalScore(fen: string): Score | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: c.turn() === "w" ? -10_000 : 10_000, mate: null };
  if (c.isDraw() || c.isStalemate()) return { cp: 0, mate: null };
  return null;
}
