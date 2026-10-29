/**
 * Test d'intégration : vrai serveur socket.io sur port éphémère, vrais clients,
 * vrais JWT. Vérifie le chemin complet file → partie → règlement → game:over.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import type {
  ArenaJwtClaims, ClientToServerEvents, GameOverEvent, GameStartEvent, MoveAck, PresenceEvent, ServerToClientEvents,
} from "@chessarena/shared";
import { createGameServer, type GameServer } from "../src/app.js";
import { defaultConfig, type GameServerConfig } from "../src/config.js";
import { InMemoryLedger } from "../src/settlement/ledger.js";
import type { InMemoryGameRepository } from "../src/persistence/GameRepository.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const SECRET = "integration-secret-integration-secret";
const cfg: GameServerConfig = {
  ...defaultConfig,
  jwtSecret: SECRET,
  matchmakerTickMs: 25,
  disconnectGraceMs: 400,
  lagProbeIntervalMs: 50,
  analysisEnabled: false,
  auditLogPath: join(mkdtempSync(join(tmpdir(), "arena-")), "audit.jsonl"),
};

let server: GameServer;
let url: string;
const clients: Client[] = [];

beforeAll(async () => {
  server = createGameServer(cfg, { ledger: new InMemoryLedger() });
  url = `http://localhost:${await server.listen(0)}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await server.close();
});

const token = (claims: Partial<ArenaJwtClaims> & { sub: string }) => jwt.sign(claims, SECRET, { expiresIn: "5m" });

function client(auth: Record<string, unknown>): Client {
  const c: Client = connect(url, { transports: ["websocket"], auth, reconnection: false, forceNew: true });
  clients.push(c);
  return c;
}

function once<E extends keyof ServerToClientEvents>(c: Client, ev: E, ms = 3000): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout en attendant ${String(ev)}`)), ms);
    (c as unknown as { once: (e: string, f: (p: unknown) => void) => void }).once(ev as string, (p) => {
      clearTimeout(t);
      resolve(p as Parameters<ServerToClientEvents[E]>[0]);
    });
  });
}

const connected = (c: Client) => new Promise<void>((res, rej) => {
  c.on("connect", () => res());
  c.on("connect_error", rej);
});

const move = (c: Client, gameId: string, uci: string, ply: number) =>
  new Promise<MoveAck>((res) => c.emit("game:move", { gameId, uci, ply }, res));

/** Deux joueurs qui se trouvent dans la même file ; retourne qui a les Blancs. */
async function pair(a: string, b: string, rating = 1500) {
  const ca = client({ token: token({ sub: a, ratings: { blitz_3_0: rating } }) });
  const cb = client({ token: token({ sub: b, ratings: { blitz_3_0: rating + 10 } }) });
  await Promise.all([connected(ca), connected(cb)]);
  const starts = Promise.all([once(ca, "game:start"), once(cb, "game:start")]);
  ca.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 200 } });
  cb.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 200 } });
  const [start] = (await starts) as [GameStartEvent, GameStartEvent];
  const white = start.white.userId === a ? ca : cb;
  const black = white === ca ? cb : ca;
  return { start, white, black, ca, cb };
}

describe("gateway WebSocket", () => {
  it("refuse une connexion sans JWT ou avec un JWT invalide", async () => {
    await expect(connected(client({}))).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connected(client({ token: jwt.sign({ sub: "x" }, "mauvais-secret") }))).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connected(client({ userId: "devauth-interdit" }))).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("refuse l'argent réel (kill-switch OFF) et un compte suspendu", async () => {
    const c = client({ token: token({ sub: "rm", kyc: true, country: "FR" }) });
    await connected(c);
    const err = once(c, "error");
    c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "EUR", buyInCents: 200 } });
    expect((await err).code).toBe("REAL_MONEY_DISABLED");

    // l'état du compte vient de la BASE : un JWT qui se prétend « active » ne suffit pas
    (server.repo as InMemoryGameRepository).states.set("susp", "suspended");
    await expect(connected(client({ token: token({ sub: "susp", state: "active" }) }))).rejects.toThrow(/ACCOUNT_SUSPENDED/);
  });

  it("un WITHDRAWAL_HOLD en base n'empêche ni la connexion ni le jeu (et n'est jamais signalé)", async () => {
    (server.repo as InMemoryGameRepository).states.set("held", "withdrawal_hold");
    const h = client({ token: token({ sub: "held" }) });
    await connected(h);
    const errors: string[] = [];
    h.on("error", (e) => errors.push(e.code));
    const joined = once(h, "queue:joined");
    h.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    await joined;
    h.emit("queue:leave");
    expect(errors).toEqual([]);
  });

  it("refuse les payloads invalides et les mises hors limites", async () => {
    const c = client({ token: token({ sub: "bad" }) });
    await connected(c);
    const e1 = once(c, "error");
    c.emit("queue:join", { timeControl: "blitz_9_9" } as never);
    expect((await e1).code).toBe("BAD_PAYLOAD");
    const e2 = once(c, "error");
    c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 100_000 } });
    expect((await e2).code).toBe("BAD_STAKE");
  });

  it("queue:join puis queue:leave", async () => {
    const c = client({ token: token({ sub: "leaver" }) });
    await connected(c);
    const joined = once(c, "queue:joined");
    c.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    await joined;
    expect(server.matchmaker.isQueued("leaver")).toBe(true);
    const left = once(c, "queue:left");
    c.emit("queue:leave");
    await left;
    expect(server.matchmaker.isQueued("leaver")).toBe(false);
  });
});

describe("partie complète", () => {
  it("appariement → coups (acks) → mat → règlement PLAY avec rake", async () => {
    const { start, white, black } = await pair("alice", "bob");
    const id = start.gameId;
    expect(start.timeControl.id).toBe("blitz_3_0");

    expect(await move(black, id, "e7e5", 0)).toEqual({ ok: false, code: "NOT_YOUR_TURN" });
    expect(await move(white, id, "e2e5", 0)).toEqual({ ok: false, code: "ILLEGAL_MOVE" });
    expect(await move(white, id, "f2f3", 0)).toEqual({ ok: true, ply: 1 });
    expect(await move(black, id, "e7e5", 1)).toEqual({ ok: true, ply: 2 });
    expect(await move(white, id, "g2g4", 2)).toEqual({ ok: true, ply: 3 });
    const overW = once(white, "game:over");
    const overB = once(black, "game:over");
    expect(await move(black, id, "d8h4", 3)).toEqual({ ok: true, ply: 4 });
    const [o] = (await Promise.all([overW, overB])) as [GameOverEvent, GameOverEvent];

    const blackId = start.black.userId;
    const whiteId = start.white.userId;
    expect(o).toMatchObject({ result: "0-1", termination: "checkmate", rakeCents: 40 });
    expect(o.payouts).toEqual({ [blackId]: 360, [whiteId]: 0 });
    // faucet 10 000 − 200 + 360 pour le gagnant, 10 000 − 200 pour le perdant
    expect(await server.ledger.balance(`user:${blackId}:PLAY`, "PLAY")).toBe(10_160);
    expect(await server.ledger.balance(`user:${whiteId}:PLAY`, "PLAY")).toBe(9_800);
    expect(await server.ledger.balance("house:rake:PLAY", "PLAY")).toBe(40);
    expect((server.ledger as InMemoryLedger).totalOf("PLAY")).toBe(0); // partie double : Σ = 0
    expect(server.games.activeGames).toBe(0);
  });

  it("game:state diffusé aux deux joueurs avec horodatage serveur", async () => {
    const { start, white, black } = await pair("carol", "dave");
    const stB = once(black, "game:state");
    await move(white, start.gameId, "e2e4", 0);
    const st = await stB;
    expect(st).toMatchObject({ gameId: start.gameId, ply: 1, turn: "b", lastMoveUci: "e2e4" });
    expect(Math.abs(st.serverTs - Date.now())).toBeLessThan(1000);
    white.emit("game:resign", { gameId: start.gameId }); // ply 1 → annulée
    const over = await once(black, "game:over");
    expect(over).toMatchObject({ termination: "aborted", rakeCents: 0 });
    expect(Object.values(over.payouts)).toEqual([200, 200]); // remboursement intégral
  });

  it("déconnexion : grâce, puis forfait", async () => {
    const { start, white, black } = await pair("erin", "frank");
    await move(white, start.gameId, "e2e4", 0);
    await move(black, start.gameId, "e7e5", 1);
    const presence = once(black, "game:presence");
    const over = once(black, "game:over", 3000);
    white.disconnect();
    expect(await presence).toMatchObject({ userId: start.white.userId, connected: false, graceMs: 400 } satisfies Partial<PresenceEvent>);
    expect(await over).toMatchObject({ result: "0-1", termination: "abandon" });
  });

  it("reconnexion dans le délai : resynchronisation et reprise", async () => {
    const { start, white, black } = await pair("gina", "hugo");
    await move(white, start.gameId, "d2d4", 0);
    await move(black, start.gameId, "d7d5", 1);
    const lost = once(black, "game:presence");
    white.disconnect();
    await lost;

    const back = client({ token: token({ sub: start.white.userId }) });
    const resync = once(back, "game:state");
    const regained = once(black, "game:presence");
    await connected(back);
    expect(await resync).toMatchObject({ gameId: start.gameId, ply: 2, turn: "w" });
    expect(await regained).toMatchObject({ connected: true });
    expect(await move(back, start.gameId, "c2c4", 2)).toEqual({ ok: true, ply: 3 });
    back.emit("game:resign", { gameId: start.gameId });
    expect(await once(black, "game:over")).toMatchObject({ termination: "resignation" });
  });

  it("refuse de rejoindre une file pendant une partie", async () => {
    const { start, white, black } = await pair("ivan", "judy");
    const err = once(white, "error");
    white.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 0 } });
    expect((await err).code).toBe("IN_GAME");
    black.emit("game:resign", { gameId: start.gameId });
    await once(white, "game:over");
  });

  it("rate limiting : un client qui inonde est freiné, le serveur reste sain", async () => {
    const c = client({ token: token({ sub: "spammer" }) });
    await connected(c);
    const errors: string[] = [];
    c.on("error", (e) => errors.push(e.code));
    for (let i = 0; i < 100; i++) c.emit("game:resign", { gameId: "nope" });
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.filter((e) => e === "RATE_LIMITED").length).toBeGreaterThan(50);
    // un événement avec accusé de réception reçoit une réponse même freiné (pas de client bloqué)
    const acks = await Promise.all(Array.from({ length: 30 }, () =>
      new Promise<MoveAck>((r) => c.emit("game:move", { gameId: "nope", uci: "e2e4", ply: 0 }, r))));
    expect(acks.some((a) => !a.ok && a.code === "RATE_LIMITED")).toBe(true);
    expect(server.metrics.snapshot({}).rateLimited).toBeGreaterThan(50);
  });

  it("expose /metrics (la DoD p99 < 5 ms est vérifiée par scripts/loadtest.ts, pas ici : trop peu d'échantillons, JIT froid)", async () => {
    const r = await fetch(`${url}/metrics`);
    const m = (await r.json()) as { moveHandlingMs: { count: number; p99: number }; activeGames: number };
    expect(m.moveHandlingMs.count).toBeGreaterThan(0);
    expect(typeof m.moveHandlingMs.p99).toBe("number");
    expect(m).toHaveProperty("eventLoopDelayMs");
  });
});
