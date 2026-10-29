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
});
