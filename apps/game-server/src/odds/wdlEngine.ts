import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { Wdl } from "./odds.js";
import { wdlForWhite } from "./odds.js";

/** Évaluation d'une position du point de vue des Blancs : WDL (pour mille) et centipions. */
export interface PositionEval { wdl: Wdl; cp: number | null; depth: number }
export type Evaluate = (fen: string) => Promise<PositionEval | null>;

/** Commande du moteur : STOCKFISH_CMD, sinon le build WASM du paquet npm `stockfish` lancé avec Node. */
export function defaultEngineCommand(): string[] | null {
  if (process.env.STOCKFISH_CMD) return process.env.STOCKFISH_CMD.split(" ").filter(Boolean);
  try {
    const require = createRequire(import.meta.url);
    return [process.execPath, require.resolve("stockfish/bin/stockfish-19-lite-single.js")];
  } catch {
    return null;
  }
}

export function parseWdlLine(line: string): { wdl: Wdl; cp: number | null; depth: number } | null {
  if (!line.startsWith("info") || / multipv [2-9]/.test(line) || line.includes("bound")) return null;
  const w = line.match(/ wdl (\d+) (\d+) (\d+)/);
  if (!w) return null;
  const cp = line.match(/ score cp (-?\d+)/);
  const mate = line.match(/ score mate (-?\d+)/);
  const depth = Number(line.match(/ depth (\d+)/)?.[1] ?? 0);
  // mat : ±10 000 (camp au trait) ; « mate 0 » : le camp au trait est maté
  const cpv = cp ? Number(cp[1]) : mate ? (Number(mate[1]) > 0 ? 10_000 : -10_000) : null;
  return { wdl: { w: Number(w[1]), d: Number(w[2]), l: Number(w[3]) }, cp: cpv, depth };
}

/**
 * Un processus Stockfish, une position à la fois (`go movetime`), WDL activé. Redémarre après un plantage.
 * Pensé pour un serveur modeste : un seul thread, 16 Mo de table de hachage.
 */
export class WdlEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private onLine: ((l: string) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cmd: string[], private readonly movetimeMs = 800) {}

  private start(): ChildProcessWithoutNullStreams {
    const [c, ...args] = this.cmd;
    const p = spawn(c!, args, { stdio: "pipe" });
    createInterface({ input: p.stdout }).on("line", (l) => this.onLine?.(l));
    p.on("exit", () => { if (this.proc === p) this.proc = null; });
    p.on("error", () => { if (this.proc === p) this.proc = null; });
    p.stdin.on("error", () => {});
    p.stdin.write("uci\nsetoption name Threads value 1\nsetoption name Hash value 16\nsetoption name UCI_ShowWDL value true\nisready\n");
    this.proc = p;
    return p;
  }

  /** WDL du point de vue des Blancs ; null si le moteur ne répond pas (marché alors suspendu). */
  evaluate: Evaluate = (fen) => {
    const run = async (): Promise<PositionEval | null> => {
      const p = this.proc ?? this.start();
      const turn = fen.split(" ")[1] === "b" ? "b" : "w";
      let last: { wdl: Wdl; cp: number | null; depth: number } | null = null;
      const done = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.movetimeMs + 5_000);
        this.onLine = (l) => {
          const x = parseWdlLine(l);
          if (x) last = x;
          if (l.startsWith("bestmove")) { clearTimeout(t); resolve(); }
        };
      });
      p.stdin.write(`position fen ${fen}\ngo movetime ${this.movetimeMs}\n`);
      await done;
      this.onLine = null;
      if (!last) { p.kill("SIGKILL"); this.proc = null; return null; }
      const l = last as { wdl: Wdl; cp: number | null; depth: number };
      return { wdl: wdlForWhite(l.wdl, turn), cp: l.cp === null ? null : turn === "w" ? l.cp : -l.cp, depth: l.depth };
    };
    const r = this.chain.then(run, run);
    this.chain = r.catch(() => null);
    return r;
  };

  close(): void { this.proc?.kill("SIGKILL"); this.proc = null; }
}
