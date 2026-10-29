import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { availableParallelism } from "node:os";
import { createInterface } from "node:readline";

/**
 * Pilote UCI d'un processus Stockfish.
 *
 * Production : binaire natif Stockfish 19 (image Docker, version épinglée).
 * Tests / dev sans binaire : build WASM officiel du paquet npm `stockfish`
 * (`STOCKFISH_CMD="node …/stockfish-19-lite-single.js"`). Même protocole.
 *
 * L'éval UCI est donnée du point de vue du camp AU TRAIT.
 */
export interface EngineEval {
  /** centipions, camp au trait ; mat converti en ±(MATE_CP − distance) */
  cp: number;
  /** null si pas de mat ; > 0 : le camp au trait mate en N ; < 0 : il est maté en N */
  mate: number | null;
  bestMove: string;
}

export const MATE_CP = 10_000;

export class EngineCrashedError extends Error {}
export class EngineTimeoutError extends Error {}

export interface EngineOptions {
  /** commande complète, ex. "stockfish" ou "node /path/stockfish-19-lite-single.js" */
  command: string;
  threads?: number;
  hashMb?: number;
  /** délai max d'une évaluation (ms) — au-delà, le processus est tué et remplacé */
  evalTimeoutMs?: number;
}

export function parseInfoScore(line: string): { cp: number; mate: number | null } | null {
  const m = line.match(/ score (cp|mate) (-?\d+)/);
  if (!m) return null;
  const v = Number(m[2]);
  if (m[1] === "cp") return { cp: v, mate: null };
  // "mate 0" : le camp au trait est maté (position terminale)
  return { cp: v > 0 ? MATE_CP - v : -MATE_CP - v, mate: v };
}

export class UciEngine {
  private proc: ChildProcessWithoutNullStreams;
  private waiters: Array<{ match: (l: string) => boolean; resolve: (l: string) => void; reject: (e: Error) => void }> = [];
  private lastScore: { cp: number; mate: number | null } | null = null;
  private dead = false;
  name = "stockfish";

  constructor(private readonly opts: EngineOptions) {
    const [cmd, ...args] = opts.command.split(" ").filter(Boolean);
    this.proc = spawn(cmd!, args, { stdio: "pipe" });
    createInterface({ input: this.proc.stdout }).on("line", (l) => this.onLine(l));
    this.proc.on("exit", () => this.die(new EngineCrashedError("processus moteur terminé")));
    this.proc.on("error", (e) => this.die(new EngineCrashedError(e.message)));
    this.proc.stdin.on("error", () => { /* EPIPE après crash : géré par 'exit' */ });
  }

  get alive(): boolean {
    return !this.dead;
  }

  async init(): Promise<void> {
    this.send("uci");
    await this.waitFor((l) => l === "uciok", 30_000);
    this.send(`setoption name Threads value ${this.opts.threads ?? 1}`);
    this.send(`setoption name Hash value ${this.opts.hashMb ?? 64}`);
    await this.ready();
  }

  async newGame(): Promise<void> {
    this.send("ucinewgame");
    await this.ready();
  }

  async evaluate(fen: string, depth: number): Promise<EngineEval> {
    this.lastScore = null;
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    let line: string;
    try {
      line = await this.waitFor((l) => l.startsWith("bestmove"), this.opts.evalTimeoutMs ?? 60_000);
    } catch (e) {
      if (e instanceof EngineTimeoutError) this.kill();
      throw e;
    }
    const bestMove = line.split(" ")[1] ?? "(none)";
    const s = this.lastScore ?? { cp: 0, mate: null };
    return { cp: s.cp, mate: s.mate, bestMove };
  }

  kill(): void {
    if (!this.dead) this.proc.kill("SIGKILL");
    this.die(new EngineCrashedError("moteur arrêté"));
  }

  quit(): void {
    if (this.dead) return;
    this.send("quit");
    setTimeout(() => this.kill(), 1_000).unref();
  }

  private async ready(): Promise<void> {
    this.send("isready");
    await this.waitFor((l) => l === "readyok", 30_000);
  }

  private send(cmd: string): void {
    if (!this.dead) this.proc.stdin.write(cmd + "\n");
  }

  private onLine(l: string): void {
    if (l.startsWith("id name ")) this.name = l.slice(8).trim();
    // dernière ligne "info" principale (multipv 1) portant un score
    if (l.startsWith("info") && l.includes(" score ") && !/ multipv [2-9]/.test(l) && !l.includes(" lowerbound") && !l.includes(" upperbound")) {
      this.lastScore = parseInfoScore(l);
    }
    const i = this.waiters.findIndex((w) => w.match(l));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(l);
  }

  private waitFor(match: (l: string) => boolean, timeoutMs: number): Promise<string> {
    if (this.dead) return Promise.reject(new EngineCrashedError("moteur indisponible"));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== res);
        reject(new EngineTimeoutError(`pas de réponse du moteur en ${timeoutMs} ms`));
      }, timeoutMs);
      const res = (l: string) => { clearTimeout(t); resolve(l); };
      this.waiters.push({ match, resolve: res, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  private die(e: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.waiters) w.reject(e);
    this.waiters = [];
  }
}

/**
 * Pool de moteurs : par défaut 1 processus mono-thread par cœur disponible
 * (le parallélisme se fait ENTRE parties, pas dans la recherche : rendement optimal
 * et résultats déterministes à profondeur fixe).
 *
 * Un moteur qui plante ou dépasse son délai est remplacé automatiquement ; la
 * partie en cours d'analyse échoue et sera rejouée par BullMQ (tentatives + backoff).
 */
export class EnginePool {
  private idle: UciEngine[] = [];
  private waiting: Array<(e: UciEngine) => void> = [];
  private closed = false;
  replaced = 0;
  name = "stockfish";

  readonly size: number;

  constructor(private readonly opts: EngineOptions & { size?: number }) {
    this.size = Math.max(1, opts.size ?? availableParallelism());
  }

  async init(): Promise<void> {
    const engines = await Promise.all(Array.from({ length: this.size }, () => this.spawn()));
    this.name = engines[0]!.name;
    this.idle.push(...engines);
  }

  get available(): number {
    return this.idle.length;
  }

  async use<T>(fn: (e: UciEngine) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("pool fermé");
    let engine = this.idle.pop() ?? (await new Promise<UciEngine>((r) => this.waiting.push(r)));
    try {
      if (!engine.alive) engine = await this.replace(engine);
      return await fn(engine);
    } finally {
      if (!engine.alive && !this.closed) {
        // remplacement en arrière-plan ; l'appelant reçoit déjà l'erreur d'origine
        engine = await this.replace(engine).catch((e) => { console.error("[pool] respawn impossible", e); return engine; });
      }
      const next = this.waiting.shift();
      if (next) next(engine);
      else this.idle.push(engine);
    }
  }

  close(): void {
    this.closed = true;
    for (const e of this.idle) e.quit();
    this.idle = [];
  }

  private async replace(old: UciEngine): Promise<UciEngine> {
    old.kill();
    this.replaced++;
    return this.spawn();
  }

  private async spawn(): Promise<UciEngine> {
    const e = new UciEngine(this.opts);
    await e.init();
    return e;
  }
}
