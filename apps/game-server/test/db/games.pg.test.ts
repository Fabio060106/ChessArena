import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TIME_CONTROLS, type GameResult } from "@chessarena/shared";
import { PgGameRepository } from "../../src/persistence/GameRepository.js";
import type { FinishedGame } from "../../src/game/GameRoom.js";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";

let db: TestDb;
let repo: PgGameRepository;

function game(w: string, b: string, result: GameResult, extra: Partial<FinishedGame> = {}): FinishedGame {
  return {
    gameId: randomUUID(), white: { userId: w, rating: 0 }, black: { userId: b, rating: 0 },
    timeControl: TIME_CONTROLS.blitz_3_0, stake: { currency: "PLAY", buyInCents: 0 }, result,
    termination: result === "1/2-1/2" ? "agreement" : "checkmate", pgn: "1. e4 e5", moveTimesMs: [0, 0, 1234.6],
    focusLoss: { w: 0, b: 0 }, aborted: false, abortedBy: null, rated: true, tournament: null, ...extra,
  };
}

describe.skipIf(!pgAvailable())("PgGameRepository — parties et Elo persistés", () => {
  beforeAll(async () => {
    db = await createTestDb();
    repo = new PgGameRepository(db.pool);
  });
  afterAll(async () => { await db?.drop(); });

  it("enregistre la partie, met à jour les deux classements et l'historique, atomiquement", async () => {
    const g = game("alice", "bob", "1-0");
    const rec = await repo.recordGame(g);
    expect(rec.changes).toMatchObject({ alice: { before: 1500, after: 1520, k: 40 }, bob: { before: 1500, after: 1480, k: 40 } });
    const row = (await db.pool.query("SELECT * FROM games WHERE id = $1", [g.gameId])).rows[0];
    expect(row).toMatchObject({ white_id: "alice", result: "1-0", rated: true, white_rating_after: 1520, black_rating_after: 1480 });
    expect(row.move_times_ms).toEqual([0, 0, 1235]);
    const r = await repo.getRatings("alice");
    expect(r.blitz_3_0).toEqual({ rating: 1520, games: 1, peak: 1520 });
    expect(r.rapid_5_0.rating).toBe(1500); // classement indépendant par cadence
    const hist = await db.pool.query("SELECT user_id, rating_before, rating_after, k_factor, score FROM rating_history WHERE game_id = $1 ORDER BY user_id", [g.gameId]);
    expect(hist.rows).toEqual([
      { user_id: "alice", rating_before: 1500, rating_after: 1520, k_factor: 40, score: "1.0" },
      { user_id: "bob", rating_before: 1500, rating_after: 1480, k_factor: 40, score: "0.0" },
    ]);
  });

  it("idempotent : un même résultat reçu 5 fois en parallèle n'est appliqué qu'une fois", async () => {
    const g = game("carol", "dave", "0-1");
    const recs = await Promise.all(Array.from({ length: 5 }, () => repo.recordGame(g)));
    expect(recs.filter((r) => !r.duplicate)).toHaveLength(1);
    for (const r of recs) expect(r.changes!.dave!.after).toBe(1520);
    expect((await repo.getRatings("dave")).blitz_3_0.games).toBe(1);
  });

  it("partie annulée : enregistrée, non classée", async () => {
    const g = game("erin", "frank", "1/2-1/2", { aborted: true, abortedBy: "w", rated: false, termination: "aborted" });
    const rec = await repo.recordGame(g);
    expect(rec).toMatchObject({ rated: false, changes: null });
    expect((await db.pool.query("SELECT aborted_by FROM games WHERE id = $1", [g.gameId])).rows[0].aborted_by).toBe("w");
    expect((await repo.getRatings("erin")).blitz_3_0.games).toBe(0);
  });

  it("K passe de 40 à 20 à la 31e partie, puis à 10 au-delà de 2400", async () => {
    for (let i = 0; i < 30; i++) await repo.recordGame(game("grind", `opp${i}`, "1/2-1/2"));
    expect((await repo.recordGame(game("grind", "oppX", "1/2-1/2"))).changes!.grind!.k).toBe(20);
    await db.pool.query("UPDATE ratings SET rating = 2405, peak = 2405 WHERE user_id = 'grind'");
    expect((await repo.recordGame(game("grind", "oppY", "1-0"))).changes!.grind!.k).toBe(10);
  });

  it("parties concurrentes d'un même joueur : aucune mise à jour perdue", async () => {
    // impossible en jeu réel (une partie à la fois), mais le verrou doit tenir
    await Promise.all(Array.from({ length: 10 }, (_, i) => repo.recordGame(game("busy", `o-busy-${i}`, "1-0"))));
    const r = await repo.getRatings("busy");
    expect(r.blitz_3_0.games).toBe(10);
    const hist = await db.pool.query("SELECT rating_before, rating_after FROM rating_history WHERE user_id = 'busy' ORDER BY id");
    // l'historique forme une suite continue : chaque partie part du résultat de la précédente
    for (let i = 1; i < hist.rows.length; i++) expect(hist.rows[i].rating_before).toBe(hist.rows[i - 1].rating_after);
    expect(r.blitz_3_0.rating).toBe(hist.rows.at(-1).rating_after);
  });

  it("parties et historique sont immuables", async () => {
    await expect(db.pool.query("UPDATE games SET result = '0-1'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM rating_history")).rejects.toThrow(/append-only/);
  });

  it("historique : du plus récent au plus ancien, vu de chaque camp, pagination, PGN réservé aux joueurs", async () => {
    const g1 = game("hist-a", "hist-b", "1-0");
    const g2 = game("hist-b", "hist-a", "1/2-1/2");
    const g3 = game("hist-a", "hist-c", "0-1", { aborted: true, abortedBy: "w", rated: false, termination: "aborted" });
    for (const g of [g1, g2, g3]) {
      await repo.recordGame(g);
      await new Promise((r) => setTimeout(r, 15)); // ended_at distincts
    }
    const a = await repo.listGames("hist-a", 10);
    expect(a.map((x) => x.gameId)).toEqual([g3.gameId, g2.gameId, g1.gameId]);
    expect(a[2]).toMatchObject({ color: "w", opponent: "hist-b", outcome: "win", ratingBefore: 1500, ratingAfter: 1520, opponentRating: 1500, plies: 3 });
    expect(a[1]).toMatchObject({ color: "b", outcome: "draw", termination: "agreement" });
    expect(a[0]).toMatchObject({ outcome: "aborted", ratingBefore: null });
    const page2 = await repo.listGames("hist-a", 2, a[1]!.endedAt);
    expect(page2.map((x) => x.gameId)).toEqual([g1.gameId]);
    expect((await repo.getGame("hist-b", g1.gameId))).toMatchObject({ outcome: "loss", pgn: "1. e4 e5", moveTimesMs: [0, 0, 1235] });
    expect(await repo.getGame("hist-c", g1.gameId)).toBeNull();
    expect(await repo.getGame("hist-a", "pas-un-uuid")).toBeNull();
  });

  it("répertoire : parties non annulées avec PGN, document JSON enregistré puis remplacé", async () => {
    const g1 = game("rep-a", "rep-b", "1-0", { pgn: "1. e4 Nf6 2. e5 Nd5" });
    const g2 = game("rep-b", "rep-a", "0-1", { pgn: "1. d4 d5" });
    const g3 = game("rep-a", "rep-c", "0-1", { aborted: true, abortedBy: "w", rated: false, termination: "aborted" });
    for (const g of [g1, g2, g3]) { await repo.recordGame(g); await new Promise((r) => setTimeout(r, 15)); }
    const games = await repo.listRepertoireGames("rep-a", 50);
    expect(games.map((x) => x.gameId)).toEqual([g2.gameId, g1.gameId]);
    expect(games[1]).toMatchObject({ color: "w", outcome: "win", opponent: "rep-b", pgn: "1. e4 Nf6 2. e5 Nd5" });
    expect(games[0]).toMatchObject({ color: "b", outcome: "win" });
    expect(await repo.getRepertoire("rep-a")).toBeNull();
    await repo.saveRepertoire("rep-a", { v: 1, choices: { x: "e2e4" } });
    await repo.saveRepertoire("rep-a", { v: 1, choices: { x: "d2d4" } });
    expect((await repo.getRepertoire("rep-a"))!.data).toEqual({ v: 1, choices: { x: "d2d4" } });
    expect(await repo.getRepertoire("rep-b")).toBeNull();
  });

  it("comptes : création, unicité sans casse, e-mail unique, réclamation d'un pseudo de la bêta", async () => {
    const { PgAccountStore, hashPassword } = await import("../../src/auth/accounts.js");
    const store = new PgAccountStore(db.pool);
    const h = await hashPassword("mot-de-passe-1");
    expect(await store.create({ id: "Acc_One", passwordHash: h, flag: "FR", email: "one@example.com" })).toBe("ok");
    expect(await store.create({ id: "acc_one", passwordHash: h, flag: null, email: null })).toBe("taken");
    expect(await store.create({ id: "acc_two", passwordHash: h, flag: null, email: "ONE@example.com" })).toBe("email_taken");
    expect(await store.find("ACC_ONE")).toMatchObject({ id: "Acc_One", flag: "FR", state: "active" });
    await repo.ensureUser("beta_player"); // pseudo créé pendant la bêta, sans mot de passe
    expect((await store.find("beta_player"))!.passwordHash).toBeNull();
    expect(await store.claim({ id: "beta_player", passwordHash: h, flag: "BE", email: null })).toBe("ok");
    expect(await store.claim({ id: "beta_player", passwordHash: h, flag: "BE", email: null })).toBe("taken");
    expect((await store.find("beta_player"))!.passwordHash).toBe(h);
  });

  it("tournoi de 50 places : accepté par la base (migration 006), 129 refusé", async () => {
    const { PgTournamentStore } = await import("../../src/tournaments/TournamentStore.js");
    const { SitAndGo } = await import("../../src/tournaments/SitAndGo.js");
    const { InMemoryLedger } = await import("../../src/settlement/ledger.js");
    const store = new PgTournamentStore(db.pool);
    const t = new SitAndGo(
      { id: "00000000-0000-4000-8000-0000000000aa", formatId: "custom:x", size: 50, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: 0, rakeBps: 1000, payoutBps: [6500, 3500], createdBy: "fx", name: "Grand" },
      { ledger: new InMemoryLedger(), startGame: async (r) => r.gameId, persist: (s) => store.save(s), emit: () => {} },
    );
    for (const u of ["t50-a", "t50-b", "t50-c"]) { await repo.ensureUser(u); await t.register(u, 1500); }
    await t.startNow();
    await t.flush();
    const row = (await db.pool.query("SELECT size, status FROM tournaments WHERE id = $1", [t.id])).rows[0];
    expect(row).toEqual({ size: 50, status: "running" });
    await expect(db.pool.query("UPDATE tournaments SET size = 129 WHERE id = $1", [t.id])).rejects.toThrow();
  });
});
