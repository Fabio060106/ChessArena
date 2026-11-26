/**
 * Test d'intégration : vrai serveur socket.io sur port éphémère, vrais clients,
 * vrais JWT. Vérifie le chemin complet file → partie → règlement → game:over.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import type {
  ArenaJwtClaims, ChatAck, ChatMessage, ClientToServerEvents, GameOverEvent, LeaderboardResponse, LiveGameView, PlayerProfile, RematchAck, WatchAck, GameStartEvent, MoveAck, PresenceEvent, ServerToClientEvents, SngAck, SngSnapshot,
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
const fakeLcc = new Map<string, unknown>();
let url: string;
const clients: Client[] = [];

beforeAll(async () => {
  server = createGameServer(cfg, {
    ledger: new InMemoryLedger(),
    // faux LiveChessCloud (retransmissions)
    relayFetch: async (u: string) => (fakeLcc.has(u) ? structuredClone(fakeLcc.get(u)) : null),
    relayPool: "http://lcc.test", relayIntervals: { watched: 40, idle: 40, finished: 40 },
    // faux export Lichess (import de parties)
    importFetch: async (u: string) => (u.includes("/api/games/user/Baron_Test?") ? [
      JSON.stringify({ id: "IMPORT01", variant: "standard", speed: "blitz", createdAt: 1, status: "mate", winner: "white", players: { white: { user: { name: "Baron_Test", id: "baron_test" }, rating: 1800 }, black: { user: { name: "B", id: "b" }, rating: 1700 } }, opening: { name: "Italian Game: Giuoco Piano" }, moves: "e4 e5 Nf3 Nc6 Bc4 Bc5" }),
      JSON.stringify({ id: "IMPORT02", variant: "standard", speed: "rapid", createdAt: 2, status: "resign", winner: "white", players: { white: { user: { name: "C", id: "c" }, rating: 1700 }, black: { user: { name: "Baron_Test", id: "baron_test" }, rating: 1800 } }, opening: { name: "Sicilian Defense" }, moves: "e4 c5 Nf3 d6" }),
    ].join("\n") : null),
  });
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

describe("tournois créés par les joueurs, historique, HUD", () => {
  const sng = <E extends "sng:create" | "sng:join" | "sng:get" | "sng:start">(c: Client, ev: E, p: Parameters<ClientToServerEvents[E]>[0]) =>
    new Promise<SngAck>((res) => (c.emit as (e: string, p: unknown, cb: (r: SngAck) => void) => void)(ev, p, res));

  it("créer un tournoi gratuit à 4, le rejoindre par son id ; il démarre quand il est complet", async () => {
    const names = ["cr-ana", "cr-ben", "cr-cleo", "cr-dan"];
    const cs = names.map((n) => client({ token: token({ sub: n, flag: "FR" }) }));
    await Promise.all(cs.map(connected));
    const created = await sng(cs[0]!, "sng:create", { size: 4, timeControl: "blitz_3_0", buyInCents: 0, name: "  Soirée   en famille " });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const t = created.snapshot;
    expect(t).toMatchObject({ createdBy: "cr-ana", name: "Soirée en famille", size: 4, currency: "PLAY", buyInCents: 0, status: "registering" });
    expect(t.formatId).toMatch(/^custom:/);
    // second tournoi du même créateur refusé ; valeurs hors bornes refusées
    expect(await sng(cs[0]!, "sng:create", { size: 4, timeControl: "blitz_3_0", buyInCents: 0 })).toMatchObject({ ok: false, code: "IN_TOURNAMENT" });
    expect(await sng(cs[1]!, "sng:create", { size: 129, timeControl: "blitz_3_0", buyInCents: 0 })).toMatchObject({ ok: false, code: "BAD_PAYLOAD" });
    expect(await sng(cs[1]!, "sng:create", { size: 4, timeControl: "blitz_3_0", buyInCents: 999_999 })).toMatchObject({ ok: false, code: "BAD_PAYLOAD" });
    // page d'invitation : état lisible sans être inscrit
    expect(await sng(cs[1]!, "sng:get", { tournamentId: t.id })).toMatchObject({ ok: true, snapshot: { id: t.id } });
    expect(await sng(cs[1]!, "sng:get", { tournamentId: "inconnu" })).toMatchObject({ ok: false, code: "UNKNOWN_TOURNAMENT" });
    // le lobby affiche le tournoi créé en premier
    const lobby = await new Promise<SngSnapshot[]>((res) => cs[1]!.emit("sng:list", res));
    expect(lobby[0]?.id).toBe(t.id);

    const starts = cs.map((c) => once(c, "game:start", 5000));
    for (const c of cs.slice(1)) expect((await sng(c, "sng:join", { tournamentId: t.id })).ok).toBe(true);
    const games = (await Promise.all(starts)) as GameStartEvent[];
    expect(new Set(games.map((g) => g.gameId)).size).toBe(2); // 2 demi-finales
    // l'interface sait que c'est une partie de tournoi (pas de revanche) ; premier coup : 45 s
    expect(games[0]!.tournament).toMatchObject({ tournamentId: t.id, round: 1, kind: "main" });
    expect(games[0]!.firstMoveMs).toBe(45_000);
    expect(games[0]!.white.flag ?? games[0]!.black.flag).toBe("FR");
    // la table a quitté le lobby
    const after = await new Promise<SngSnapshot[]>((res) => cs[0]!.emit("sng:list", res));
    expect(after.some((x) => x.id === t.id)).toBe(false);
    for (const [i, c] of cs.entries()) c.emit("game:resign", { gameId: games[i]!.gameId });
  });

  it("le créateur qui quitte son tournoi vide l'annule", async () => {
    const c = client({ token: token({ sub: "cr-solo" }) });
    await connected(c);
    const created = await sng(c, "sng:create", { size: 6, timeControl: "rapid_5_0", buyInCents: 100 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const left = await new Promise<SngAck>((res) => c.emit("sng:unregister", { tournamentId: created.snapshot.id }, res));
    expect(left).toMatchObject({ ok: true });
    expect((await sng(c, "sng:get", { tournamentId: created.snapshot.id })) as { snapshot: SngSnapshot }).toMatchObject({ snapshot: { status: "cancelled" } });
    // il peut en créer un autre
    expect((await sng(c, "sng:create", { size: 4, timeControl: "bullet_1_0", buyInCents: 0 })).ok).toBe(true);
  });

  it("inscrit à un tournoi : la recherche de duel est refusée avec un code explicite, puis possible après désinscription", async () => {
    const c = client({ token: token({ sub: "inscrit-duel" }) });
    await connected(c);
    const created = await sng(c, "sng:create", { size: 4, timeControl: "blitz_3_0", buyInCents: 0 });
    if (!created.ok) throw new Error("création");
    const refused = once(c, "error");
    c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 0 } });
    expect(await refused).toMatchObject({ code: "IN_TOURNAMENT" });
    await new Promise<SngAck>((res) => c.emit("sng:unregister", { tournamentId: created.snapshot.id }, res));
    const joined = once(c, "queue:joined");
    c.emit("queue:join", { timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 0 } });
    await joined;
    c.emit("queue:leave");
    c.disconnect();
  });

  it("historique : la partie jouée apparaît, avec son PGN, pour les deux joueurs seulement", async () => {
    const { start, white, black } = await pair("hist-w", "hist-b");
    await move(white, start.gameId, "f2f3", 0);
    await move(black, start.gameId, "e7e5", 1);
    await move(white, start.gameId, "g2g4", 2);
    const over = once(white, "game:over");
    await move(black, start.gameId, "d8h4", 3); // mat du berger inversé
    await over;
    await new Promise((r) => setTimeout(r, 300)); // enregistrement asynchrone
    const wId = start.white.userId;
    const get = (path: string, sub: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token({ sub })}` } });
    const list = (await (await get("/account/games?limit=5", wId)).json()) as { games: Array<Record<string, unknown>> };
    expect(list.games[0]).toMatchObject({ gameId: start.gameId, color: "w", outcome: "loss", result: "0-1", termination: "checkmate", plies: 4 });
    const detail = (await (await get(`/account/games/${start.gameId}`, start.black.userId)).json()) as { pgn: string; outcome: string };
    expect(detail.outcome).toBe("win");
    expect(detail.pgn).toContain("Qh4#");
    expect((await get(`/account/games/${start.gameId}`, "intrus")).status).toBe(404);
    expect((await fetch(`${url}/account/games`)).status).toBe(401);
  });

  it("ping des deux joueurs diffusé pendant la partie", async () => {
    const { start, white, black } = await pair("net-w", "net-b");
    for (const c of [white, black]) c.on("lag:probe", (_ts, ack) => ack(Date.now()));
    const net = await new Promise<{ rttMs: Record<"w" | "b", number | null> }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("pas de game:net complet")), 3000);
      white.on("game:net", (p) => { if (p.gameId === start.gameId && p.rttMs.w !== null && p.rttMs.b !== null) { clearTimeout(t); resolve(p); } });
    });
    expect(net.rttMs.w).toBeLessThan(1000);
    white.emit("game:resign", { gameId: start.gameId });
  });
});

describe("tournoi de taille libre, départ anticipé par le créateur", () => {
  const sng = (c: Client, ev: string, p: unknown) =>
    new Promise<SngAck>((res) => (c.emit as (e: string, p: unknown, cb: (r: SngAck) => void) => void)(ev, p, res));

  it("tournoi de 50 places lancé à 3 : seul le créateur peut le lancer, la tête de série 1 est exempte", async () => {
    const names = ["fx-ana", "fx-ben", "fx-cleo"];
    const cs = names.map((n) => client({ token: token({ sub: n }) }));
    await Promise.all(cs.map(connected));
    const created = await sng(cs[0]!, "sng:create", { size: 50, timeControl: "blitz_3_0", buyInCents: 0, name: "Grand tournoi" });
    expect(created).toMatchObject({ ok: true, snapshot: { size: 50, status: "registering" } });
    if (!created.ok) return;
    const id = created.snapshot.id;
    expect(await sng(cs[0]!, "sng:start", { tournamentId: id })).toMatchObject({ ok: false, code: "NOT_ENOUGH_PLAYERS" });
    expect((await sng(cs[1]!, "sng:join", { tournamentId: id })).ok).toBe(true);
    expect(await sng(cs[0]!, "sng:start", { tournamentId: id })).toMatchObject({ ok: false, code: "NOT_ENOUGH_PLAYERS" }); // 2 : pas un tournoi
    expect(await sng(cs[1]!, "sng:create", { size: 2, timeControl: "blitz_3_0", buyInCents: 0 })).toMatchObject({ ok: false });
    expect((await sng(cs[2]!, "sng:join", { tournamentId: id })).ok).toBe(true);
    expect(await sng(cs[1]!, "sng:start", { tournamentId: id })).toMatchObject({ ok: false, code: "NOT_CREATOR" });
    const started = await sng(cs[0]!, "sng:start", { tournamentId: id });
    expect(started).toMatchObject({ ok: true, snapshot: { status: "running", size: 50 } });
    if (!started.ok) return;
    const r1 = started.snapshot.rounds[0]!;
    expect(r1).toHaveLength(2); // 3 joueurs → tableau de 4
    expect(r1.filter((m) => m.p2 === null)).toHaveLength(1);
    expect(started.snapshot.rounds).toHaveLength(2);
  });
});

describe("comptes via HTTP (jeton de service du serveur web)", () => {
  const svc = () => jwt.sign({ sub: "web" }, SECRET, { audience: "chessarena-auth-service", expiresIn: 60 });
  const post = (path: string, body: unknown, auth = svc()) => fetch(`${url}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("inscription puis connexion ; refusé sans jeton de service ; le compte peut ensuite jouer", async () => {
    const r1 = await post("/auth/signup", { pseudo: "Http_Player", password: "un-bon-mdp-1", flag: "FR", adult: true, terms: true });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ userId: "Http_Player", flag: "FR" });
    const r2 = await post("/auth/login", { pseudo: "http_player", password: "un-bon-mdp-1" });
    expect(await r2.json()).toEqual({ userId: "Http_Player", flag: "FR" });
    expect((await post("/auth/login", { pseudo: "Http_Player", password: "faux" })).status).toBe(401);
    // un jeton de joueur (sans audience) ne permet pas d'appeler /auth/*
    expect((await post("/auth/login", { pseudo: "Http_Player", password: "un-bon-mdp-1" }, token({ sub: "x" }))).status).toBe(401);
    // et le jeton de service ne permet pas de jouer
    const c = client({ token: svc() });
    const err = await new Promise<string>((res) => c.on("connect_error", (e) => res(e.message)));
    expect(err).toMatch(/token invalide/);
  });
});

describe("organisateur : codes de réinitialisation, signalements et chat coupé", () => {
  const svc = () => jwt.sign({ sub: "web" }, SECRET, { audience: "chessarena-auth-service", expiresIn: 60 });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${svc()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("seul l'organisateur génère un code ; le joueur s'en sert ; signalement puis chat coupé", async () => {
    await post("/auth/signup", { pseudo: "Oubli_Mdp", password: "premier-mdp-1", adult: true, terms: true });
    expect(await (await post("/auth/admin/check", { by: "Fabio060106" })).json()).toEqual({ admin: true });
    expect(await (await post("/auth/admin/check", { by: "Oubli_Mdp" })).json()).toEqual({ admin: false });
    expect((await post("/auth/admin/reset-code", { by: "Oubli_Mdp", target: "Oubli_Mdp" })).status).toBe(403);
    const r = (await (await post("/auth/admin/reset-code", { by: "fabio060106", target: "oubli_mdp" })).json()) as { code: string; userId: string };
    expect(r.userId).toBe("Oubli_Mdp");
    expect((await post("/auth/password/reset", { pseudo: "oubli_mdp", code: r.code, password: "second-mdp-2" })).status).toBe(200);
    expect((await post("/auth/login", { pseudo: "Oubli_Mdp", password: "second-mdp-2" })).status).toBe(200);
    expect((await post("/auth/password/change", { userId: "Oubli_Mdp", current: "second-mdp-2", next: "troisieme-mdp-3" })).status).toBe(200);
    expect((await post("/auth/login", { pseudo: "Oubli_Mdp", password: "troisieme-mdp-3" })).status).toBe(200);

    // signalement d'un message, puis l'organisateur coupe le chat du joueur
    for (const pz of ["mod-a", "mod-b"]) await post("/auth/signup", { pseudo: pz, password: "mot-de-passe-1", adult: true, terms: true });
    const { start, white, black } = await pair("mod-a", "mod-b");
    const got = once(black, "chat:msg");
    await new Promise<ChatAck>((res) => white.emit("chat:send", { gameId: start.gameId, text: "message insultant" }, res));
    const m = (await got) as ChatMessage;
    expect(await new Promise((res) => white.emit("chat:report", { gameId: start.gameId, messageId: m.id }, res))).toEqual({ ok: false }); // pas son propre message
    expect(await new Promise((res) => black.emit("chat:report", { gameId: start.gameId, messageId: m.id }, res))).toEqual({ ok: true });
    const rep = (await (await post("/auth/admin/reports", { by: "Fabio060106" })).json()) as { reports: Array<{ reported: string; message: string }> };
    expect(rep.reports.at(-1)).toMatchObject({ reported: start.white.userId, message: "message insultant" });
    expect((await post("/auth/admin/mute", { by: "Fabio060106", target: start.white.userId, muted: true })).status).toBe(200);
    expect(await new Promise<ChatAck>((res) => white.emit("chat:send", { gameId: start.gameId, text: "encore" }, res))).toEqual({ ok: false, code: "MUTED" });
    await post("/auth/admin/mute", { by: "Fabio060106", target: start.white.userId, muted: false });
    expect(await new Promise<ChatAck>((res) => white.emit("chat:send", { gameId: start.gameId, text: "pardon" }, res))).toEqual({ ok: true });
    white.emit("game:resign", { gameId: start.gameId });
  });
});

describe("social : spectateurs, chat, revanche, profil, classement", () => {
  it("un spectateur suit la partie, les chats sont séparés, puis revanche couleurs inversées", async () => {
    const { start, white, black } = await pair("soc-a", "soc-b");
    const id = start.gameId;
    const spec = client({ token: token({ sub: "soc-spec" }) });
    await connected(spec);

    const live = await new Promise<LiveGameView[]>((r) => spec.emit("watch:list", r));
    expect(live.map((g) => g.gameId)).toContain(id);
    const count = once(white, "game:spectators");
    const w = await new Promise<WatchAck>((r) => spec.emit("watch:start", { gameId: id }, r));
    expect(w.ok && w.snapshot).toMatchObject({ moves: [], spectators: 1, tournamentId: null });
    expect(await count).toEqual({ gameId: id, count: 1 });
    expect(await new Promise<WatchAck>((r) => white.emit("watch:start", { gameId: id }, r))).toEqual({ ok: false, code: "IS_PLAYER" });

    const seen = once(spec, "game:state");
    await move(white, id, "f2f3", 0);
    expect((await seen).ply).toBe(1);

    // chat des joueurs : lu par l'adversaire ET les spectateurs
    const toBlack = once(black, "chat:msg");
    const toSpec = once(spec, "chat:msg");
    expect(await new Promise<ChatAck>((r) => white.emit("chat:send", { gameId: id, text: " bonne  chance " }, r))).toEqual({ ok: true });
    expect(await toBlack).toMatchObject({ channel: "players", userId: start.white.userId, text: "bonne chance" });
    expect((await toSpec).text).toBe("bonne chance");

    // chat des spectateurs : jamais transmis aux joueurs (pas de conseils pendant la partie)
    const leaked: ChatMessage[] = [];
    black.on("chat:msg", (m) => leaked.push(m));
    const specEcho = once(spec, "chat:msg");
    await new Promise<ChatAck>((r) => spec.emit("chat:send", { gameId: id, text: "joue Dh4 !" }, r));
    expect(await specEcho).toMatchObject({ channel: "spectators", text: "joue Dh4 !" });
    await new Promise((r) => setTimeout(r, 200));
    expect(leaked).toHaveLength(0);
    black.off("chat:msg");

    // un inconnu (ni joueur ni spectateur) ne peut pas écrire
    const intrus = client({ token: token({ sub: "soc-intrus" }) });
    await connected(intrus);
    expect(await new Promise<ChatAck>((r) => intrus.emit("chat:send", { gameId: id, text: "coucou" }, r))).toEqual({ ok: false, code: "NO_GAME" });

    // fin de partie : le spectateur la reçoit
    await move(black, id, "e7e5", 1);
    await move(white, id, "g2g4", 2);
    const specOver = once(spec, "game:over");
    await move(black, id, "d8h4", 3);
    expect((await specOver).result).toBe("0-1");
    await new Promise((r) => setTimeout(r, 100));

    // chat d'après-partie entre les joueurs
    const gg = once(white, "chat:msg");
    await new Promise<ChatAck>((r) => black.emit("chat:send", { gameId: id, text: "gg" }, r));
    expect((await gg).text).toBe("gg");

    // revanche : proposée par les Blancs, acceptée par les Noirs → couleurs inversées
    const offerSeen = once(black, "rematch");
    expect(await new Promise<RematchAck>((r) => white.emit("rematch", { gameId: id, action: "offer" }, r))).toEqual({ ok: true, started: false });
    expect(await offerSeen).toEqual({ gameId: id, offeredBy: start.white.userId });
    const starts = Promise.all([once(white, "game:start"), once(black, "game:start")]);
    expect(await new Promise<RematchAck>((r) => black.emit("rematch", { gameId: id, action: "offer" }, r))).toEqual({ ok: true, started: true });
    const [s2] = (await starts) as [GameStartEvent, GameStartEvent];
    expect(s2.white.userId).toBe(start.black.userId);
    expect(s2.black.userId).toBe(start.white.userId);
    expect(s2.timeControl.id).toBe("blitz_3_0");
    expect(s2.stake).toEqual(start.stake);
    expect(await new Promise<RematchAck>((r) => white.emit("rematch", { gameId: id, action: "offer" }, r))).toMatchObject({ ok: false });

    // profil (pseudo insensible à la casse) et classement
    const get = (path: string, sub: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token({ sub })}` } });
    const prof = (await (await get("/account/players/SOC-B", "soc-spec")).json()) as PlayerProfile;
    expect(prof).toMatchObject({ userId: "soc-b", liveGameId: s2.gameId });
    expect(prof.totals.games).toBe(1);
    expect(prof.recent[0]).toMatchObject({ gameId: id });
    expect(prof.ratings.blitz_3_0.games).toBe(1);
    expect((await get("/account/players/personne-xyz", "soc-spec")).status).toBe(404);
    const lb = (await (await get("/account/leaderboard?tc=blitz_3_0", start.black.userId)).json()) as LeaderboardResponse;
    expect(lb.entries.map((e) => e.userId)).toEqual(expect.arrayContaining(["soc-a", "soc-b"]));
    expect(lb.me?.userId).toBe(start.black.userId);
    expect(lb.entries.find((e) => e.userId === start.black.userId)!.rating).toBeGreaterThan(lb.entries.find((e) => e.userId === start.white.userId)!.rating);
    expect((await get("/account/leaderboard?tc=nimporte", "soc-a")).status).toBe(400);

    // historique complet : toutes les parties d'un joueur (paginées) et export PGN de ses propres parties
    const all = (await (await get("/account/players/soc-a/games", "soc-spec")).json()) as { games: Array<{ gameId: string }> };
    expect(all.games.map((g) => g.gameId)).toContain(id);
    expect((await get("/account/players/inconnu-zz/games", "soc-spec")).status).toBe(404);
    expect((await get("/account/players/soc-a/games?before=pas-une-date", "soc-spec")).status).toBe(400);
    const exp = await get("/account/games/export", "soc-a");
    expect(exp.headers.get("content-type")).toContain("pgn");
    const pgn = await exp.text();
    expect(pgn).toContain("Qh4#");
    expect(pgn).toMatch(/\[(White|Black) "soc-a"\]/);
  });

  it("revanche refusée ; impossible après un tournoi ou si l'adversaire rejoue déjà", async () => {
    const { start, white, black } = await pair("soc-c", "soc-d");
    const id = start.gameId;
    const over = once(white, "game:over");
    white.emit("game:resign", { gameId: id });
    await over;
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<RematchAck>((r) => white.emit("rematch", { gameId: id, action: "offer" }, r));
    const declined = once(white, "rematch");
    await new Promise<RematchAck>((r) => black.emit("rematch", { gameId: id, action: "decline" }, r));
    expect(await declined).toEqual({ gameId: id, offeredBy: null, declined: true });
    // les Noirs repartent en file : plus de revanche possible, les Blancs le voient
    await new Promise<RematchAck>((r) => black.emit("rematch", { gameId: id, action: "offer" }, r));
    const withdrawn = once(white, "rematch");
    black.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    expect(await withdrawn).toEqual({ gameId: id, offeredBy: null, declined: true, unavailable: true });
    expect(await new Promise<RematchAck>((r) => white.emit("rematch", { gameId: id, action: "offer" }, r))).toMatchObject({ ok: false });
    black.emit("queue:leave");
  });
});

describe("historique : aucune partie perdue", () => {
  it("si la base refuse l'enregistrement, la partie est gardée et enregistrée dès que la base revient", async () => {
    const { InMemoryGameRepository } = await import("../src/persistence/GameRepository.js");
    class FlakyRepo extends InMemoryGameRepository {
      down = true;
      override async recordGame(g: Parameters<InMemoryGameRepository["recordGame"]>[0]) {
        if (this.down) throw new Error("base indisponible");
        return super.recordGame(g);
      }
    }
    const repo = new FlakyRepo();
    const s2 = createGameServer(cfg, { ledger: new InMemoryLedger(), repo });
    const u2 = `http://localhost:${await s2.listen(0)}`;
    const mk = (sub: string) => { const c: Client = connect(u2, { transports: ["websocket"], auth: { token: token({ sub }) }, reconnection: false, forceNew: true }); clients.push(c); return c; };
    const a = mk("flaky-a"); const b = mk("flaky-b");
    await Promise.all([connected(a), connected(b)]);
    const st = once(a, "game:start");
    a.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    b.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    const start = (await st) as GameStartEvent;
    const over = once(a, "game:over", 10_000);
    a.emit("game:resign", { gameId: start.gameId });
    await over;
    await vi.waitFor(() => expect(s2.games.pendingRecords).toBe(1), { timeout: 8_000 });
    expect(repo.games.size).toBe(0);
    repo.down = false;
    expect(await s2.games.flushUnrecorded()).toBe(0);
    expect(repo.games.has(start.gameId)).toBe(true);
    await s2.close();
  }, 20_000);
});

describe("anti-triche de base : signaux, signalement, revue par l'organisateur", () => {
  const svc = () => jwt.sign({ sub: "web" }, SECRET, { audience: "chessarena-auth-service", expiresIn: 60 });
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${svc()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("sorties d'onglet → partie à revoir ; l'adversaire signale ; l'organisateur juge ; le tricheur est déconnecté", async () => {
    const { start, white, black } = await pair("fp-honnete", "fp-suspect");
    const id = start.gameId;
    const suspect = start.white.userId === "fp-suspect" ? white : black;
    const honest = suspect === white ? black : white;
    for (let i = 0; i < 4; i++) suspect.emit("game:signal", { gameId: id, kind: "focus_lost", clientTs: Date.now() });
    await move(white, id, "e2e4", 0);
    await move(black, id, "e7e5", 1);
    const over = once(honest, "game:over");
    suspect.emit("game:resign", { gameId: id });
    await over;
    await new Promise((r) => setTimeout(r, 150));

    // seul un joueur de la partie peut signaler
    const intrus = client({ token: token({ sub: "fp-intrus" }) });
    await connected(intrus);
    expect(await new Promise((r) => intrus.emit("cheat:report", { gameId: id, reason: "?" }, r))).toEqual({ ok: false, code: "NOT_A_PLAYER" });
    expect(await new Promise((r) => honest.emit("cheat:report", { gameId: id, reason: "il jouait comme un moteur" }, r))).toEqual({ ok: true });

    expect((await post("/auth/admin/fairplay", { by: "fp-honnete" })).status).toBe(403);
    const list = (await (await post("/auth/admin/fairplay", { by: "Fabio060106" })).json()) as { cases: Array<{ gameId: string; userId: string; reasons: string[]; reports: string[] }> };
    const c = list.cases.find((x) => x.gameId === id && x.userId === "fp-suspect")!;
    expect(c.reasons).toEqual(["a quitté l'onglet de la partie 4 fois"]);
    expect(c.reports).toEqual(["fp-honnete : il jouait comme un moteur"]);
    expect(list.cases.some((x) => x.gameId === id && x.userId === "fp-honnete")).toBe(false);

    const gone = once(suspect, "disconnect");
    expect((await post("/auth/admin/fairplay-review", { by: "Fabio060106", gameId: id, userId: "fp-suspect", verdict: "cheat" })).status).toBe(200);
    await gone;
    const after = (await (await post("/auth/admin/fairplay", { by: "Fabio060106" })).json()) as { cases: Array<{ gameId: string }> };
    expect(after.cases.some((x) => x.gameId === id)).toBe(false);
  });
});

describe("amis et défis directs", () => {
  const svc = () => jwt.sign({ sub: "web" }, SECRET, { audience: "chessarena-auth-service", expiresIn: 60 });
  const signup = (pseudo: string) => fetch(`${url}/auth/signup`, {
    method: "POST", headers: { authorization: `Bearer ${svc()}`, "content-type": "application/json" },
    body: JSON.stringify({ pseudo, password: "mot-de-passe-1", adult: true, terms: true }),
  });
  const api = (method: string, path: string, user: string, body?: unknown) => fetch(`${url}${path}`, {
    method, headers: { authorization: `Bearer ${token({ sub: user })}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  type Friend = { userId: string; online: boolean; liveGameId: string | null };

  it("ajout par pseudo, présence, défi accepté → partie ; refus ; défi expiré si hors ligne", async () => {
    for (const p of ["Ami_A", "Ami_B", "Ami_C"]) await signup(p);
    expect((await api("POST", "/account/friends", "Ami_A", { pseudo: "inconnu_xyz" })).status).toBe(404);
    expect((await api("POST", "/account/friends", "Ami_A", { pseudo: "ami_a" })).status).toBe(400);
    expect(await (await api("POST", "/account/friends", "Ami_A", { pseudo: "ami_b" })).json()).toEqual({ ok: true, userId: "Ami_B" });
    await api("POST", "/account/friends", "Ami_A", { pseudo: "Ami_C" });
    let list = (await (await api("GET", "/account/friends", "Ami_A")).json()) as { friends: Friend[] };
    expect(list.friends.map((f) => [f.userId, f.online])).toEqual([["Ami_B", false], ["Ami_C", false]]);

    const a = client({ token: token({ sub: "Ami_A" }) });
    const b = client({ token: token({ sub: "Ami_B" }) });
    await Promise.all([connected(a), connected(b)]);
    list = (await (await api("GET", "/account/friends", "Ami_A")).json()) as { friends: Friend[] };
    expect(list.friends.find((f) => f.userId === "Ami_B")!.online).toBe(true);

    // hors ligne : refus immédiat
    expect(await new Promise((r) => a.emit("challenge:send", { to: "Ami_C", timeControl: "blitz_3_0" }, r))).toEqual({ ok: false, code: "OFFLINE" });
    // refus
    let incoming = once(b, "challenge:incoming");
    const sent = await new Promise<unknown>((r) => a.emit("challenge:send", { to: "ami_b", timeControl: "rapid_5_0" }, r));
    expect(sent).toMatchObject({ ok: true, challenge: { from: "Ami_A", to: "Ami_B", timeControl: "rapid_5_0" } });
    const c1 = await incoming;
    const declined = once(a, "challenge:update");
    expect(await new Promise((r) => b.emit("challenge:answer", { id: c1.id, accept: false }, r))).toEqual({ ok: true });
    expect(await declined).toEqual({ id: c1.id, status: "declined" });
    // accepté → partie classée PLAY sans mise
    incoming = once(b, "challenge:incoming");
    await new Promise((r) => a.emit("challenge:send", { to: "Ami_B", timeControl: "blitz_3_0" }, r));
    const c2 = await incoming;
    const starts = Promise.all([once(a, "game:start"), once(b, "game:start")]);
    const upd = once(a, "challenge:update");
    expect(await new Promise((r) => b.emit("challenge:answer", { id: c2.id, accept: true }, r))).toEqual({ ok: true });
    const u = await upd;
    expect(u).toMatchObject({ id: c2.id, status: "accepted" });
    const [s] = (await starts) as [GameStartEvent, GameStartEvent];
    expect(s.gameId).toBe(u.gameId);
    expect(s.stake).toEqual({ currency: "PLAY", buyInCents: 0 });
    expect([s.white.userId, s.black.userId].sort()).toEqual(["Ami_A", "Ami_B"]);
    // double réponse : sans effet
    expect(await new Promise((r) => b.emit("challenge:answer", { id: c2.id, accept: true }, r))).toEqual({ ok: false, code: "EXPIRED" });
    list = (await (await api("GET", "/account/friends", "Ami_A")).json()) as { friends: Friend[] };
    expect(list.friends.find((f) => f.userId === "Ami_B")!.liveGameId).toBe(s.gameId);
    // en partie : on ne peut plus défier
    expect(await new Promise((r) => a.emit("challenge:send", { to: "Ami_B", timeControl: "blitz_3_0" }, r))).toEqual({ ok: false, code: "IN_GAME" });
    const over = once(a, "game:over");
    b.emit("game:resign", { gameId: s.gameId });
    await over;

    // retrait de la liste
    expect((await api("DELETE", "/account/friends/Ami_C", "Ami_A")).status).toBe(200);
    list = (await (await api("GET", "/account/friends", "Ami_A")).json()) as { friends: Friend[] };
    expect(list.friends.map((f) => f.userId)).toEqual(["Ami_B"]);

    // défi annulé quand le défieur se déconnecte
    incoming = once(b, "challenge:incoming");
    await new Promise((r) => a.emit("challenge:send", { to: "Ami_B", timeControl: "blitz_3_0" }, r));
    const c3 = await incoming;
    const cancelled = once(b, "challenge:update");
    a.disconnect();
    expect(await cancelled).toEqual({ id: c3.id, status: "cancelled", reason: "OFFLINE" });
  });
});

describe("file d'attente : coupure de connexion et compteurs", () => {
  it("garde la place pendant une courte coupure, la réaffiche, et diffuse le nombre de joueurs en attente", async () => {
    const a = client({ token: token({ sub: "File_A" }) });
    await connected(a);
    const joined = once(a, "queue:joined");
    a.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    await joined;
    const obs = client({ token: token({ sub: "File_Obs" }) });
    await connected(obs);
    const st = await new Promise<Record<string, number>>((resolve) => {
      const h = (s: Record<string, number>) => { if (s["rapid_5_0|PLAY|0"] === 1) { obs.off("queue:stats", h); resolve(s); } };
      obs.on("queue:stats", h);
    });
    expect(st["rapid_5_0|PLAY|0"]).toBe(1);
    // coupure (téléphone en veille) puis retour : toujours en file, l'interface le sait
    a.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    const a2 = client({ token: token({ sub: "File_A" }) });
    const back = once(a2, "queue:joined");
    await connected(a2);
    expect(await back).toEqual({ timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    // un adversaire arrive : la partie se crée
    const b = client({ token: token({ sub: "File_B" }) });
    await connected(b);
    const start = once(a2, "game:start");
    b.emit("queue:join", { timeControl: "rapid_5_0", stake: { currency: "PLAY", buyInCents: 0 } });
    const s = (await start) as GameStartEvent;
    expect(s.tournament ?? null).toBeNull();
    expect(s.firstMoveMs).toBeGreaterThan(0);
    for (const c of [a2, b, obs]) c.disconnect();
  });
});


describe("retransmissions DGT / LiveChessCloud", () => {
  const LCC = "e3537c1f-9200-40d7-9955-c244a536fa4c";
  const base = `http://lcc.test/get/${LCC}`;
  const svcToken = () => jwt.sign({ sub: "web" }, SECRET, { audience: "chessarena-auth-service", expiresIn: 60 });
  const admin = (path: string, body: Record<string, unknown>) => fetch(`${url}/auth/admin/${path}`, {
    method: "POST", headers: { authorization: `Bearer ${svcToken()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const gk = { fname: "Gukesh", lname: "D", title: "GM" };
  const sd = { fname: "Javokhir", lname: "Sindarov", title: "GM" };

  it("l'organisateur ajoute le lien, les spectateurs reçoivent la partie en direct et peuvent discuter", async () => {
    fakeLcc.set(`${base}/tournament.json`, { name: "World Championship", rounds: [{ count: 1, live: 1 }] });
    fakeLcc.set(`${base}/round-1/index.json`, { pairings: [{ live: true, white: sd, black: gk, result: "*" }] });
    fakeLcc.set(`${base}/round-1/game-1.json`, { moves: ["e4 7200"], clock: { white: 7190, black: 7200, time: 1 } });
    // réservé à l'organisateur ; lien vérifié
    expect((await admin("relay-add", { by: "intrus", url: `https://view.livechesscloud.com/#${LCC}` })).status).toBe(403);
    expect((await admin("relay-add", { by: "Fabio060106", url: "https://exemple.com" })).status).toBe(400);
    const add = await admin("relay-add", { by: "Fabio060106", url: `https://view.livechesscloud.com/#${LCC}`, name: "Championnat du monde" });
    const { relay } = (await add.json()) as { relay: { id: string } };
    expect(relay.id).toMatch(/^[0-9a-f]{8}$/);
    // lien Lichess Broadcast accepté (source de secours)
    const li = await admin("relay-add", { by: "Fabio060106", url: "https://lichess.org/broadcast/fide-world-championship-2026/AbCd1234", name: "CM (Lichess)" });
    const liRelay = ((await li.json()) as { relay: { id: string; source: string; lccId: string } }).relay;
    expect(liRelay).toMatchObject({ source: "lichess", lccId: "tour:AbCd1234" });
    await admin("relay-remove", { by: "Fabio060106", id: liRelay.id });

    const c = client({ token: token({ sub: "spectateur-cm" }) });
    await connected(c);
    let view = null as null | import("@chessarena/shared").RelayRoundView;
    for (let i = 0; i < 40 && !(view?.gameList.length); i++) {
      const r = await new Promise<{ ok: boolean; round?: import("@chessarena/shared").RelayRoundView }>((res) => c.emit("relay:watch", { relayId: relay.id }, res as never));
      view = r.round ?? null;
      if (!view?.gameList.length) await new Promise((r2) => setTimeout(r2, 30));
    }
    expect(view).toMatchObject({ name: "Championnat du monde", tournamentName: "World Championship", currentRound: 1, live: true });
    expect(view!.gameList[0]!.sans).toEqual(["e4"]);

    // un coup joué à Genève arrive tout seul
    const next = once(c, "relay:game");
    fakeLcc.set(`${base}/round-1/game-1.json`, { moves: ["e4 7200", "e5 7195"], clock: { white: 7190, black: 7195, time: 2 } });
    const g = (await next) as { relayId: string; game: { sans: string[]; turn: string } };
    expect(g.relayId).toBe(relay.id);
    expect(g.game.sans).toEqual(["e4", "e5"]);
    expect(g.game.turn).toBe("w");

    // analyse partagée : refusée tant que la partie n'est pas finie ; ensuite gardée et servie à tous
    const review = { version: 4, summary: "Victoire des Blancs.", moves: ["e4", "e5"].map((san, i) => ({ ply: i + 1, san })) };
    // envoi par HTTP (une analyse dépasse la taille maximale d'un message websocket)
    const save = async (rv: unknown, sans = ["e4", "e5"], tries = 6): Promise<{ ok: boolean; saved?: boolean; status?: number }> => {
      const r = await fetch(`${url}/account/relay-review`, {
        method: "POST", headers: { authorization: `Bearer ${token({ sub: "spectateur-cm" })}`, "content-type": "application/json" },
        body: JSON.stringify({ relayId: relay.id, round: 1, index: 1, sans, review: rv }),
      });
      const j = (await r.json()) as { ok?: boolean; saved?: boolean; error?: string; code?: string };
      // limite de débit HTTP par adresse IP (toute la suite tourne depuis 127.0.0.1) : on patiente
      if (r.status === 429 && tries > 0) { await new Promise((w) => setTimeout(w, 1000)); return save(rv, sans, tries - 1); }
      return r.ok ? { ok: true, saved: j.saved } : { ok: false, status: r.status };
    };
    expect(await save(review)).toEqual({ ok: false, status: 404 });
    const ended = once(c, "relay:game");
    fakeLcc.set(`${base}/round-1/index.json`, { pairings: [{ live: false, white: sd, black: gk, result: "1-0" }] });
    fakeLcc.set(`${base}/round-1/game-1.json`, { moves: ["e4 7200", "e5 7195"], result: "1-0" });
    await ended;
    expect(await save(review, ["e4", "e6"])).toEqual({ ok: false, status: 409 });
    expect(await save({ ...review, version: 1 })).toEqual({ ok: false, status: 400 });
    expect(await save(review)).toEqual({ ok: true, saved: true });
    expect(await save({ ...review, summary: "autre" })).toEqual({ ok: true, saved: false });
    // une vraie analyse fait ~20 Ko (bien plus que les 16 Ko d'un message websocket) : acceptée
    const big = { ...review, summary: "x".repeat(30_000) };
    await new Promise((r) => setTimeout(r, 1500)); // limite de débit HTTP par adresse IP
    expect(await save(big)).toMatchObject({ ok: true });
    expect(await new Promise((r) => c.emit("relay:review", { relayId: relay.id, round: 1, index: 1, plies: 2 }, r))).toEqual({ review });

    // chat entre spectateurs de la retransmission
    const msg = once(c, "chat:msg");
    expect(await new Promise((r) => c.emit("chat:send", { gameId: `relay:${relay.id}`, text: "Quelle ouverture !" }, r))).toEqual({ ok: true });
    expect(await msg).toMatchObject({ channel: "spectators", userId: "spectateur-cm", text: "Quelle ouverture !" });

    // liste publique (joueurs connectés), puis suppression
    const list = await fetch(`${url}/account/relays`, { headers: { authorization: `Bearer ${token({ sub: "spectateur-cm" })}` } });
    expect(((await list.json()) as { relays: Array<{ id: string }> }).relays.map((x) => x.id)).toContain(relay.id);
    expect(await (await admin("relay-remove", { by: "Fabio060106", id: relay.id })).json()).toEqual({ ok: true });
    expect(await new Promise((r) => c.emit("relay:watch", { relayId: relay.id }, r as never))).toEqual({ ok: false, code: "UNKNOWN_RELAY" });
    c.disconnect();
  });
});

describe("import de parties Lichess", () => {
  // la limite de débit HTTP par adresse IP (toute la suite tourne depuis 127.0.0.1) : on patiente ; IMPORT_TOO_SOON est la vraie réponse attendue
  const api = async (method: string, path: string, body?: unknown, tries = 8): Promise<Response> => {
    const r = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token({ sub: "importeur" })}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && tries > 0 && !(await r.clone().text()).includes("IMPORT_TOO_SOON")) { await new Promise((w) => setTimeout(w, 1000)); return api(method, path, body, tries - 1); }
    return r;
  };
  it("import en arrière-plan → parties dans le répertoire, ouvertures, suppression", async () => {
    expect((await api("POST", "/account/imports", { username: "../x" })).status).toBe(400);
    expect((await api("POST", "/account/imports", { username: "Baron_Test", speeds: ["blitz", "rapid"] })).status).toBe(202);
    let st: { count: number; status: { state: string; added: number }; openings: Array<{ name: string; color: string; games: number; score: number }> } | null = null;
    for (let i = 0; i < 20; i++) {
      st = await (await api("GET", "/account/imports")).json() as typeof st;
      if (st!.status.state !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(st).toMatchObject({ count: 2, status: { state: "done", added: 2 } });
    expect(st!.openings).toEqual(expect.arrayContaining([{ name: "Italian Game", color: "w", games: 1, score: 100 }, { name: "Sicilian Defense", color: "b", games: 1, score: 0 }]));
    expect((await api("POST", "/account/imports", { username: "Baron_Test" })).status).toBe(429); // une minute entre deux imports
    const rep = await (await api("GET", "/account/repertoire")).json() as { games: Array<{ gameId: string; source?: string; pgn: string }> };
    expect(rep.games.filter((g) => g.source === "lichess").map((g) => g.gameId).sort()).toEqual(["lichess:IMPORT01", "lichess:IMPORT02"]);
    expect(await (await api("DELETE", "/account/imports")).json()).toEqual({ deleted: 2 });
    expect((await (await api("GET", "/account/imports")).json() as { count: number }).count).toBe(0);
  });
});
