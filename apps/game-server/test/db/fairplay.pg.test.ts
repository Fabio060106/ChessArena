/**
 * Application des verdicts (FairPlayEnforcer) et arbitrage (ModerationService)
 * sur PostgreSQL réel, avec de vraies parties à enjeu réglées par le grand livre.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { VERDICT_QUEUE, type VerdictEvent } from "@chessarena/shared";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";
import { redisAvailable, testRedis } from "@chessarena/testkit/redis";
import { acct, applySettlement, lockStakes, PgLedger } from "../../src/settlement/ledger.js";
import { settleDuel } from "../../src/settlement/rake.js";
import { WithdrawalService } from "../../src/settlement/withdrawals.js";
import { FairPlayEnforcer } from "../../src/fairplay/FairPlayEnforcer.js";
import { CaseAlreadyResolvedError, ModerationService } from "../../src/fairplay/ModerationService.js";
import { NullAuditLog } from "../../src/audit/auditLog.js";
import { redisConnection } from "../../src/anticheat/analysisQueue.js";
import { seedEur } from "../helpers.js";

let db: TestDb;
let ledger: PgLedger;
let withdrawals: WithdrawalService;
let enforcer: FairPlayEnforcer;
let moderation: ModerationService;
const audit = new NullAuditLog();
const banned: string[] = [];

const verdict = (userId: string, level: "watch" | "hold", gameIds: string[], score = 80): VerdictEvent => ({
  userId, level, score, reasons: ["ACPL < 10 sur 3 parties consécutives"], gameIds, depth: 18, ruleVersion: "test", at: new Date().toISOString(),
});
const state = async (u: string) => (await db.pool.query("SELECT state, fairplay_watch FROM users WHERE id = $1", [u])).rows[0];
const bal = (u: string, c: "EUR" | "PLAY" = "EUR") => ledger.balance(acct.user(u, c), c);

async function user(id: string, eur = 0) {
  await db.pool.query("INSERT INTO users (id, username) VALUES ($1, $1) ON CONFLICT DO NOTHING", [id]);
  await db.pool.query("UPDATE users SET kyc = 'verified' WHERE id = $1", [id]);
  if (eur) await seedEur(db.pool, ledger, id, eur);
}

let minute = 0;
/** duel EUR réel : mises bloquées, règlement avec rake, partie + analyse enregistrées */
async function duel(white: string, black: string, result: "1-0" | "0-1" | "1/2-1/2", buyIn = 200, acpl = 5, match = 0.9): Promise<string> {
  const id = randomUUID();
  await lockStakes(ledger, id, "EUR", buyIn, [white, black]);
  await applySettlement(ledger, id, "EUR", settleDuel(buyIn, white, black, result === "1-0" ? "white" : result === "0-1" ? "black" : "draw", 1000));
  const ended = new Date(Date.UTC(2026, 9, 2, 0, ++minute));
  await db.pool.query(
    `INSERT INTO games (id, white_id, black_id, time_control, currency, buy_in_cents, rated, result, termination, pgn, ended_at)
     VALUES ($1,$2,$3,'blitz_3_0','EUR',$4,true,$5,'checkmate','1. e4 e5 *',$6)`, [id, white, black, buyIn, result, ended],
  );
  const moves = [{ ply: 0, color: "w", san: "e4", uci: "e2e4", bestUci: "e2e4", evalBeforeWhite: 20, evalAfterWhite: 25, mateBeforeWhite: null, cpLoss: 0, matched: true, timeMs: 0, included: false, excludedBy: "opening" }];
  await db.pool.query("INSERT INTO anticheat_analyses (game_id, depth, engine, request, moves, duration_ms) VALUES ($1, 18, 'Stockfish 19', '{}', $2, 1000)", [id, JSON.stringify(moves)]);
  for (const [u, color] of [[white, "w"], [black, "b"]] as const) {
    await db.pool.query(
      `INSERT INTO anticheat_player_stats (game_id, depth, user_id, color, rating, currency, time_control, analysed_moves, acpl, engine_match_rate,
         time_mean_ms, time_variance, time_cv, focus_loss, game_ended_at) VALUES ($1,18,$2,$3,1500,'EUR','blitz_3_0',24,$4,$5,3000,9e6,1,0,$6)`,
      [id, u, color, u === "cheat" || u.startsWith("ch") ? acpl : 45, u === "cheat" || u.startsWith("ch") ? match : 0.5, ended],
    );
  }
  return id;
}

describe.skipIf(!pgAvailable())("fair-play : verdicts et modération", () => {
  beforeAll(async () => {
    db = await createTestDb();
    ledger = new PgLedger(db.pool);
    withdrawals = new WithdrawalService(db.pool, ledger);
    enforcer = new FairPlayEnforcer(db.pool, audit);
    moderation = new ModerationService(db.pool, ledger, withdrawals, audit, { onBanned: (u) => banned.push(u) });
  });
  afterAll(async () => { await db?.drop(); });

  describe("FairPlayEnforcer", () => {
    it("watch → dossier ouvert + surveillance ; hold → escalade + WITHDRAWAL_HOLD ; rejeu sans effet", async () => {
      await user("v1");
      const g = [randomUUID(), randomUUID(), randomUUID()];
      expect((await enforcer.apply(verdict("v1", "watch", g, 40))).action).toBe("opened");
      expect(await state("v1")).toEqual({ state: "active", fairplay_watch: true });
      const r = await enforcer.apply(verdict("v1", "hold", g));
      expect(r.action).toBe("escalated");
      expect(await state("v1")).toEqual({ state: "withdrawal_hold", fairplay_watch: true });
      expect((await enforcer.apply(verdict("v1", "hold", g))).action).toBe("updated");
      // un watch ultérieur ne fait jamais redescendre la gravité
      await enforcer.apply(verdict("v1", "watch", g, 10));
      const cases = await db.pool.query("SELECT level, score FROM anticheat_cases WHERE user_id = 'v1'");
      expect(cases.rows).toEqual([{ level: "hold", score: 80 }]);
      const decisions = await db.pool.query("SELECT action FROM moderation_decisions WHERE user_id = 'v1' ORDER BY id");
      expect(decisions.rows.map((d) => d.action)).toEqual(["open_watch", "escalate_hold"]);
      expect(audit.entries.filter((e) => e.type === "account.hold")).toHaveLength(1);
    });

    it("parties déjà jugées « clean » par un modérateur : verdict ignoré ; compte suspendu : ignoré", async () => {
      await user("v2");
      const g = [randomUUID(), randomUUID(), randomUUID()];
      const { caseId } = await enforcer.apply(verdict("v2", "hold", g));
      await moderation.decide(caseId!, "mod1", "clean", "parties analysées, jeu humain");
      expect((await enforcer.apply(verdict("v2", "hold", g))).action).toBe("ignored_already_judged");
      expect((await state("v2")).state).toBe("active");
      await db.pool.query("INSERT INTO users (id, username, state) VALUES ('gone', 'gone', 'suspended')");
      expect((await enforcer.apply(verdict("gone", "hold", g))).action).toBe("ignored_closed_account");
    });

    it.skipIf(!redisAvailable())("consommateur BullMQ : un verdict publié dans la file est appliqué", async () => {
      await user("v3");
      const r = testRedis();
      const conn = redisConnection(r.url);
      const worker = enforcer.startWorker(conn, r.prefix);
      const q = new Queue<VerdictEvent>(VERDICT_QUEUE, { connection: conn, prefix: r.prefix });
      await q.add("hold", verdict("v3", "hold", [randomUUID(), randomUUID(), randomUUID()]));
      for (let i = 0; i < 100 && (await state("v3")).state !== "withdrawal_hold"; i++) await new Promise((x) => setTimeout(x, 50));
      expect((await state("v3")).state).toBe("withdrawal_hold");
      await worker.close();
      await q.close();
    });
  });

  describe("ModerationService", () => {
    it("CHEAT : ban, retraits annulés, victimes remboursées de leur perte exacte, solde confisqué — tout s'équilibre", async () => {
      await user("cheat", 100_00);
      for (const v of ["vA", "vB", "vC", "vOld"]) await user(v, 50_00);
      const before = await duel("cheat", "vOld", "1-0");          // AVANT la période suspecte : non concernée
      const g1 = await duel("cheat", "vA", "1-0");                // vA perd sa mise (2,00)
      const g2 = await duel("vB", "cheat", "0-1");                // vB perd sa mise (2,00)
      const g3 = await duel("cheat", "vC", "1/2-1/2");            // vC récupère 1,80 : perte 0,20 (rake)
      const { caseId } = await enforcer.apply(verdict("cheat", "hold", [g1, g2, g3]));
      const wd = await withdrawals.request("cheat", 50_00);
      expect(await withdrawals.processOne(wd.id)).toBe("held");

      const detail = await moderation.getCase(caseId!);
      expect(detail.games.filter((g) => g.isTrigger).map((g) => g.gameId).sort()).toEqual([g1, g2, g3].sort());
      expect(detail.pendingWithdrawalCents).toBe(50_00);
      expect(detail.games[0]!.moves[0]).toMatchObject({ san: "e4", matched: true });
      expect(before).toBeTruthy();

      const cheatBefore = await bal("cheat");
      const r = await moderation.decide(caseId!, "mod-alice", "cheat", "coïncidence moteur 90 % sur 3 parties, temps réguliers");
      expect(r.refunds.map((x) => [x.userId, x.amountCents]).sort()).toEqual([["vA", 200], ["vB", 200], ["vC", 20]]);
      expect(r.cancelledWithdrawals).toBe(1);
      expect(r.confiscated.EUR).toBe(cheatBefore + 50_00 - 420);
      expect(await bal("cheat")).toBe(0);
      expect(await bal("vA")).toBe(50_00);    // remis à l'état d'avant la partie truquée
      expect(await bal("vB")).toBe(50_00);
      expect(await bal("vC")).toBe(50_00);
      expect(await bal("vOld")).toBe(50_00 - 200); // partie hors période : non remboursée
      expect(await ledger.balance(acct.confiscated("EUR"), "EUR")).toBe(r.confiscated.EUR);
      expect(await state("cheat")).toEqual({ state: "suspended", fairplay_watch: false });
      expect(banned).toEqual(["cheat"]);
      const rec = await ledger.reconcile();
      expect(rec).toMatchObject({ totals: { EUR: 0 }, cacheMismatches: 0, unbalancedTransactions: 0, negativeUsers: 0 });
      // décision immuable, double décision refusée
      await expect(moderation.decide(caseId!, "mod-bob", "clean", "erreur ? changement d'avis")).rejects.toBeInstanceOf(CaseAlreadyResolvedError);
      await expect(db.pool.query("DELETE FROM moderation_decisions")).rejects.toThrow(/append-only/);
      expect(audit.entries.at(-1)).toMatchObject({ type: "moderation.decision", payload: { decision: "cheat", moderatorId: "mod-alice" } });
    });

    it("CHEAT avec solde insuffisant : le fonds fair-play complète, les victimes sont intégralement remboursées", async () => {
      await user("chbroke", 4_00);
      await user("vD", 50_00);
      const g = await duel("chbroke", "vD", "1-0", 400);   // le tricheur gagne 7,20
      // il mise ailleurs et perd presque tout (partie hors dossier, adversaire honnête)
      await user("lucky", 50_00);
      await duel("lucky", "chbroke", "1-0", 700);
      const { caseId } = await enforcer.apply(verdict("chbroke", "hold", [g]));
      const left = await bal("chbroke");
      const r = await moderation.decide(caseId!, "mod", "cheat", "aveu du joueur au support");
      expect(r.refunds).toEqual([{ gameId: g, userId: "vD", currency: "EUR", amountCents: 400 }]);
      expect(await bal("vD")).toBe(50_00);
      expect(await ledger.balance(acct.fairplayFund("EUR"), "EUR")).toBe(-(400 - left));
    });

    it("CLEAN : blocage levé, retraits retenus relâchés puis payés, surveillance arrêtée", async () => {
      await user("innocent", 40_00);
      const { caseId } = await enforcer.apply(verdict("innocent", "hold", [randomUUID(), randomUUID(), randomUUID()]));
      const wd = await withdrawals.request("innocent", 25_00);
      expect(await withdrawals.processOne(wd.id)).toBe("held");
      const r = await moderation.decide(caseId!, "mod", "clean", "joueur titré en compte secondaire, vérifié");
      expect(r.releasedWithdrawals).toBe(1);
      expect(await state("innocent")).toEqual({ state: "active", fairplay_watch: false });
      expect(await withdrawals.processOne(wd.id)).toBe("sent");
    });

    it("WATCH : blocage levé mais analyses profondes maintenues", async () => {
      await user("doubt");
      const { caseId } = await enforcer.apply(verdict("doubt", "hold", [randomUUID(), randomUUID(), randomUUID()]));
      await moderation.decide(caseId!, "mod", "watch", "signal faible, à revoir sur 20 parties");
      expect(await state("doubt")).toEqual({ state: "active", fairplay_watch: true });
      expect((await moderation.listCases("resolved")).find((c) => c.id === caseId)?.resolution).toBe("watch");
    });

    it("liste des dossiers ouverts : HOLD d'abord, puis par score", async () => {
      const list = await moderation.listCases("open");
      expect(list.length).toBeGreaterThan(0);
      const levels = list.map((c) => c.level);
      expect(levels.indexOf("watch") === -1 || levels.lastIndexOf("hold") < levels.indexOf("watch")).toBe(true);
    });
  });
});
