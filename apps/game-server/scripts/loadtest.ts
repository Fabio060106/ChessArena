/**
 * Test de charge — DoD Sprint 1 : 500 parties simultanées, traitement serveur p99 < 5 ms.
 *
 *   npm run loadtest -w @chessarena/game-server                 # démarre un serveur local
 *   GAMES=500 TARGET=http://host:4000 JWT_SECRET=… npm run loadtest   # serveur existant
 *
 * Le serveur tourne dans un PROCESS SÉPARÉ des clients simulés, sinon les deux
 * se partagent la même boucle d'événements et la mesure ne veut rien dire.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Chess } from "chess.js";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, GameStartEvent, GameStateEvent, MoveAck, ServerToClientEvents } from "@chessarena/shared";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const GAMES = Number(process.env.GAMES ?? 500);
const MAX_PLIES = Number(process.env.MAX_PLIES ?? 60);
const THINK_MIN_MS = Number(process.env.THINK_MIN_MS ?? 250);
const THINK_MAX_MS = Number(process.env.THINK_MAX_MS ?? 750);
const P99_BUDGET_MS = Number(process.env.P99_BUDGET_MS ?? 5);
const SECRET = process.env.JWT_SECRET ?? "loadtest-secret-loadtest-secret-loadtest";
const PORT = Number(process.env.PORT ?? 4555);
const TARGET = process.env.TARGET ?? `http://localhost:${PORT}`;

let rng = 42;
const rand = () => ((rng = (rng * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quantiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(2) : 0;
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.length ? +s.at(-1)!.toFixed(2) : 0 };
}

async function startServer(): Promise<ChildProcess | null> {
  if (process.env.TARGET) return null;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: SECRET, ANALYSIS_ENABLED: "0", NODE_ENV: "development",
      AUDIT_LOG_PATH: join(mkdtempSync(join(tmpdir(), "arena-load-")), "audit.jsonl"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${TARGET}/health`)).ok) return child; } catch { /* pas encore prêt */ }
    await sleep(100);
  }
  throw new Error("le serveur ne démarre pas");
}

async function main() {
  const child = await startServer();
  const ackRtt: number[] = [];
  let finished = 0;
  let rejected = 0;
  const results: Record<string, number> = {};
  let peakGames = 0;

  console.log(`→ ${GAMES} parties (${GAMES * 2} sockets), ${MAX_PLIES} demi-coups max, réflexion ${THINK_MIN_MS}-${THINK_MAX_MS} ms`);

  let resolveAll!: () => void;
  const done = new Promise<void>((r) => (resolveAll = r));

  const makePlayer = (i: number): Promise<Client> => new Promise((ready, fail) => {
    const userId = `load-${i}`;
    const c: Client = connect(TARGET, {
      transports: ["websocket"], forceNew: true, reconnection: false,
      auth: { token: jwt.sign({ sub: userId, ratings: { blitz_3_0: 1500 } }, SECRET, { expiresIn: "1h" }) },
    });
    let game: GameStartEvent | null = null;
    const board = new Chess();
    let myColor: "w" | "b" = "w";
    let lastPlyHandled = -1;

    c.on("lag:probe", (_ts, ack) => ack(Date.now()));
    c.on("connect_error", fail);
    c.on("connect", () => ready(c));
    c.on("game:start", (g) => {
      game = g;
      myColor = g.white.userId === userId ? "w" : "b";
    });
    c.on("game:state", async (s: GameStateEvent) => {
      if (!game || s.gameId !== game.gameId || s.turn !== myColor || s.ply <= lastPlyHandled) return;
      lastPlyHandled = s.ply;
      board.load(s.fen);
      await sleep(THINK_MIN_MS + rand() * (THINK_MAX_MS - THINK_MIN_MS));
      if (!game) return;
      if (s.ply >= MAX_PLIES) return void c.emit("game:resign", { gameId: game.gameId });
      const moves = board.moves({ verbose: true });
      const m = moves[Math.floor(rand() * moves.length)]!;
      const t0 = performance.now();
      c.emit("game:move", { gameId: game.gameId, uci: m.from + m.to + (m.promotion ?? ""), ply: s.ply }, (r: MoveAck) => {
        ackRtt.push(performance.now() - t0);
        if (!r.ok) { rejected++; console.warn(userId, "coup refusé", r.code); }
      });
    });
    c.on("game:over", (o) => {
      if (myColor === "w") {
        results[o.termination] = (results[o.termination] ?? 0) + 1;
        if (++finished === GAMES) resolveAll();
      }
      game = null;
      c.disconnect();
    });
    c.on("error", (e) => console.warn(userId, e.code));
  });

  const clients: Client[] = [];
  for (let i = 0; i < GAMES * 2; i += 100) {
    // montée en charge par paquets de 100 connexions
    clients.push(...(await Promise.all(Array.from({ length: Math.min(100, GAMES * 2 - i) }, (_, k) => makePlayer(i + k)))));
  }
  console.log(`✓ ${clients.length} sockets connectés`);
  await sleep(500);
  await fetch(`${TARGET}/metrics/reset`, { method: "POST" });
  for (const c of clients) c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 200 } });

  const poll = setInterval(async () => {
    try {
      const m = (await (await fetch(`${TARGET}/metrics`)).json()) as { activeGames: number };
      peakGames = Math.max(peakGames, m.activeGames);
    } catch { /* ignore */ }
  }, 500);

  const t0 = Date.now();
  const timeout = sleep(180_000).then(() => { throw new Error(`timeout : ${finished}/${GAMES} parties terminées`); });
  await Promise.race([done, timeout]);
  clearInterval(poll);
  const metrics = (await (await fetch(`${TARGET}/metrics`)).json()) as {
    moveHandlingMs: { count: number; p50: number; p95: number; p99: number; max: number };
    eventLoopDelayMs: { p50: number; p99: number; max: number };
    movesAccepted: number; movesRejected: number; rateLimited: number; memoryMb: number;
  };

  console.log("\n═══════════════ RÉSULTATS ═══════════════");
  console.log(`Parties terminées       : ${finished}/${GAMES} en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`Pic de parties actives  : ${peakGames}`);
  console.log(`Fins de partie          : ${JSON.stringify(results)}`);
  console.log(`Coups acceptés/refusés  : ${metrics.movesAccepted} / ${metrics.movesRejected} (rate-limited: ${metrics.rateLimited})`);
  console.log(`Serveur — traitement coup (ms) : ${JSON.stringify(metrics.moveHandlingMs)}`);
  console.log(`Serveur — event loop delay (ms): ${JSON.stringify(metrics.eventLoopDelayMs)}`);
  console.log(`Serveur — mémoire RSS   : ${metrics.memoryMb} Mo`);
  console.log(`Client  — aller-retour ack (ms): ${JSON.stringify(quantiles(ackRtt))}`);
  const pass = metrics.moveHandlingMs.p99 < P99_BUDGET_MS && finished === GAMES && rejected === 0;
  console.log(`\nDoD p99 < ${P99_BUDGET_MS} ms : ${pass ? "✅ OK" : "❌ ÉCHEC"}`);

  child?.kill("SIGTERM");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
