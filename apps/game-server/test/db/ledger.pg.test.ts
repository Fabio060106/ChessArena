/**
 * PgLedger sur un VRAI PostgreSQL (isolation SERIALIZABLE).
 * Objectif : prouver qu'aucun jeton n'est créé ni détruit — ni par un bug applicatif,
 * ni par la concurrence, ni par un crash (exception, connexion tuée, SIGKILL du process).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acct, applySettlement, CurrencyMismatchError, IdempotencyConflictError, InsufficientFundsError,
  lockStakes, PgLedger, refundOrphanedEscrows, UnbalancedPostingError,
} from "../../src/settlement/ledger.js";
import { settleDuel } from "../../src/settlement/rake.js";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";

let db: TestDb;
let ledger: PgLedger;

const user = (u: string, c: "PLAY" | "EUR" = "PLAY") => acct.user(u, c);
const fund = (u: string, cents: number) => ledger.faucet(u, cents, `fund-${u}-${cents}-${Math.random()}`);
const txCount = async () => Number((await db.pool.query("SELECT count(*) AS n FROM ledger_transactions")).rows[0].n);

/** Invariants globaux, vérifiés après CHAQUE test. */
async function expectLedgerSound() {
  const r = await ledger.reconcile();
  for (const total of Object.values(r.totals)) expect(total).toBe(0); // I1 : rien de créé ni détruit
  expect(r.cacheMismatches).toBe(0);                                    // soldes = Σ écritures
  expect(r.unbalancedTransactions).toBe(0);                             // I3 : aucun lot partiel
  expect(r.negativeUsers).toBe(0);                                      // I5
}

describe.skipIf(!pgAvailable())("PgLedger — PostgreSQL réel", () => {
  beforeAll(async () => {
    db = await createTestDb();
    ledger = new PgLedger(db.pool);
  });
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => { await expectLedgerSound(); });

  describe("idempotence (I2)", () => {
    it("une même clé n'est appliquée qu'une fois", async () => {
      await fund("idem", 1000);
      const post = () => ledger.post("idem-1", "PLAY", [
        { account: user("idem"), amountCents: -100 }, { account: acct.rake("PLAY"), amountCents: 100 },
      ]);
      const first = await post();
      const second = await post();
      expect(first.status).toBe("applied");
      expect(second).toEqual({ status: "duplicate", transactionId: first.transactionId });
      expect(await ledger.balance(user("idem"), "PLAY")).toBe(900);
    });

    it("même clé, contenu différent → IdempotencyConflictError (jamais un succès silencieux)", async () => {
      await fund("idem2", 1000);
      await ledger.post("idem-2", "PLAY", [{ account: user("idem2"), amountCents: -100 }, { account: acct.rake("PLAY"), amountCents: 100 }]);
      await expect(ledger.post("idem-2", "PLAY", [{ account: user("idem2"), amountCents: -900 }, { account: acct.rake("PLAY"), amountCents: 900 }]))
        .rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it("20 envois concurrents de la même clé : exactement 1 appliqué", async () => {
      await fund("race", 1000);
      const results = await Promise.all(Array.from({ length: 20 }, () => ledger.post("race-key", "PLAY", [
        { account: user("race"), amountCents: -500 }, { account: acct.rake("PLAY"), amountCents: 500 },
      ])));
      expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(await ledger.balance(user("race"), "PLAY")).toBe(500);
    });

    it("règlement de duel rejoué (retry après crash) : payé une seule fois", async () => {
      await fund("w1", 1000); await fund("b1", 1000);
      await lockStakes(ledger, "g-settle", "PLAY", 200, ["w1", "b1"]);
      const plan = settleDuel(200, "w1", "b1", "white", 1000);
      await applySettlement(ledger, "g-settle", "PLAY", plan);
      await applySettlement(ledger, "g-settle", "PLAY", plan);
      expect(await ledger.balance(user("w1"), "PLAY")).toBe(1000 - 200 + 360);
      expect(await ledger.balance(acct.escrow("g-settle", "PLAY"), "PLAY")).toBe(0);
    });
  });

  describe("solde et équilibre (I1, I5)", () => {
    it("solde insuffisant → InsufficientFundsError, rien n'est écrit", async () => {
      await fund("poor", 100);
      const before = await txCount();
      await expect(ledger.post("poor-1", "PLAY", [
        { account: user("poor"), amountCents: -101 }, { account: acct.rake("PLAY"), amountCents: 101 },
      ])).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await txCount()).toBe(before);
      expect(await ledger.balance(user("poor"), "PLAY")).toBe(100);
    });

    it("double dépense concurrente : 10 blocages de 500 sur un solde de 500 → 1 seul passe", async () => {
      await fund("ds", 500);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
        lockStakes(ledger, `ds-game-${i}`, "PLAY", 500, ["ds"]).catch((e) => { throw e; })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(InsufficientFundsError);
      expect(await ledger.balance(user("ds"), "PLAY")).toBe(0);
    });

    it("lot déséquilibré refusé par l'application ET par la base (contournement SQL)", async () => {
      await expect(ledger.post("unb", "PLAY", [
        { account: user("x"), amountCents: 100 }, { account: acct.rake("PLAY"), amountCents: -99 },
      ])).rejects.toBeInstanceOf(UnbalancedPostingError);
      // tentative directe en SQL : rejetée au COMMIT par le trigger différé
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("INSERT INTO ledger_accounts (account, currency) VALUES ('house:hack:PLAY', 'PLAY') ON CONFLICT DO NOTHING");
        const t = await c.query("INSERT INTO ledger_transactions (idempotency_key, currency, postings_hash) VALUES ('sql-unb', 'PLAY', repeat('a', 64)) RETURNING id");
        await c.query("INSERT INTO ledger_entries (transaction_id, account, currency, amount_cents) VALUES ($1, 'house:hack:PLAY', 'PLAY', 1000000)", [t.rows[0].id]);
        await expect(c.query("COMMIT")).rejects.toThrow(/unbalanced/);
      } finally {
        await c.query("ROLLBACK").catch(() => {});
        c.release();
      }
    });

    it("concurrence soutenue : 300 virements croisés entre 10 joueurs, invariants intacts", async () => {
      for (let i = 0; i < 10; i++) await fund(`p${i}`, 1_000);
      const results = await Promise.allSettled(Array.from({ length: 300 }, (_, k) => {
        const a = k % 10;
        const b = (k * 7 + 3) % 10 === a ? (a + 1) % 10 : (k * 7 + 3) % 10;
        return ledger.post(`cross-${k}`, "PLAY", [
          { account: user(`p${a}`), amountCents: -(50 + (k % 200)) }, { account: user(`p${b}`), amountCents: 50 + (k % 200) },
        ]);
      }));
      const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      for (const f of failures) expect(f.reason).toBeInstanceOf(InsufficientFundsError); // jamais d'autre erreur
      let total = 0;
      for (let i = 0; i < 10; i++) total += await ledger.balance(user(`p${i}`), "PLAY");
      expect(total).toBe(10_000);
      await expectLedgerSound();
    });
  });

  describe("tenue en charge du compte de rake (point chaud)", () => {
    it("200 règlements de duels simultanés créditent tous house:rake sans échec", async () => {
      const N = 200;
      for (let i = 0; i < N; i++) await fund(`s${i}`, 1_000);
      await Promise.all(Array.from({ length: N / 2 }, (_, i) => lockStakes(ledger, `hot-${i}`, "PLAY", 200, [`s${2 * i}`, `s${2 * i + 1}`])));
      const rakeBefore = await ledger.balance(acct.rake("PLAY"), "PLAY");
      const results = await Promise.allSettled(Array.from({ length: N / 2 }, (_, i) =>
        applySettlement(ledger, `hot-${i}`, "PLAY", settleDuel(200, `s${2 * i}`, `s${2 * i + 1}`, "white", 1000))));
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(await ledger.balance(acct.rake("PLAY"), "PLAY")).toBe(rakeBefore + (N / 2) * 40);
    });
  });

  describe("étanchéité PLAY / EUR (I4, ADR-6)", () => {
    it("un compte PLAY dans un lot EUR est refusé avant la base", async () => {
      await expect(ledger.post("mix-1", "EUR", [
        { account: user("m", "PLAY"), amountCents: -1 }, { account: acct.rake("EUR"), amountCents: 1 },
      ])).rejects.toBeInstanceOf(CurrencyMismatchError);
    });

    it("la base refuse aussi tout contournement SQL", async () => {
      await fund("leak", 1000);
      const t = await db.pool.query("INSERT INTO ledger_transactions (idempotency_key, currency, postings_hash) VALUES ('sql-mix', 'EUR', repeat('b', 64)) RETURNING id");
      // écriture EUR sur un compte PLAY : clé étrangère (account, currency) violée
      await expect(db.pool.query(
        "INSERT INTO ledger_entries (transaction_id, account, currency, amount_cents) VALUES ($1, 'user:leak:PLAY', 'EUR', 100)", [t.rows[0].id],
      )).rejects.toThrow(/foreign key/);
      // écriture PLAY rattachée à une transaction EUR : clé étrangère (transaction_id, currency) violée
      await expect(db.pool.query(
        "INSERT INTO ledger_entries (transaction_id, account, currency, amount_cents) VALUES ($1, 'user:leak:PLAY', 'PLAY', 100)", [t.rows[0].id],
      )).rejects.toThrow(/foreign key/);
      // compte nommé PLAY déclaré en EUR : CHECK de suffixe
      await expect(db.pool.query("INSERT INTO ledger_accounts (account, currency) VALUES ('user:evil:PLAY', 'EUR')"))
        .rejects.toThrow(/account_currency_suffix/);
    });

    it("le grand livre est append-only", async () => {
      await expect(db.pool.query("UPDATE ledger_entries SET amount_cents = amount_cents * 2")).rejects.toThrow(/append-only/);
      await expect(db.pool.query("DELETE FROM ledger_transactions")).rejects.toThrow(/append-only/);
    });
  });

  describe("crash pendant une transaction (I3)", () => {
    it("exception juste avant le COMMIT : rien n'est écrit ; le rejeu de la même clé s'applique une fois", async () => {
      await fund("crash1", 1000);
      let boom = true;
      const faulty = new PgLedger(db.pool, {
        faultInjector: (stage) => { if (stage === "after_entries" && boom) throw new Error("panne simulée"); },
      });
      const before = await txCount();
      const post = () => faulty.post("crash-1", "PLAY", [
        { account: user("crash1"), amountCents: -300 }, { account: acct.rake("PLAY"), amountCents: 300 },
      ]);
      await expect(post()).rejects.toThrow("panne simulée");
      expect(await txCount()).toBe(before);
      expect(await ledger.balance(user("crash1"), "PLAY")).toBe(1000);
      boom = false;
      expect((await post()).status).toBe("applied");
      expect((await post()).status).toBe("duplicate");
      expect(await ledger.balance(user("crash1"), "PLAY")).toBe(700);
    });

    it("connexion tuée côté serveur en pleine transaction : rollback, et le pool reste sain", async () => {
      await fund("crash2", 1000);
      const killer = new PgLedger(db.pool, {
        faultInjector: async (stage, c) => {
          if (stage === "after_transaction_row") {
            const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await db.admin("SELECT pg_terminate_backend($1)", [pid]);
            await c.query("SELECT 1"); // la connexion est morte : lève une erreur
          }
        },
      });
      await expect(killer.post("crash-2", "PLAY", [
        { account: user("crash2"), amountCents: -300 }, { account: acct.rake("PLAY"), amountCents: 300 },
      ])).rejects.toThrow();
      expect(await ledger.balance(user("crash2"), "PLAY")).toBe(1000);
      expect((await db.pool.query("SELECT count(*) AS n FROM ledger_transactions WHERE idempotency_key = 'crash-2'")).rows[0].n).toBe("0");
      // le pool a détruit la connexion morte au lieu de la recycler
      expect((await ledger.post("crash-2", "PLAY", [
        { account: user("crash2"), amountCents: -300 }, { account: acct.rake("PLAY"), amountCents: 300 },
      ])).status).toBe("applied");
    });

    it("SIGKILL du process en plein trafic : tout ce qui a été confirmé est durable, rien d'autre", async () => {
      const N = 12;
      for (let i = 0; i < N; i++) await fund(`c${i}`, 5_000);
      const runId = `run${Date.now()}`;
      const child = spawn(process.execPath, [
        "--import", "tsx", fileURLToPath(new URL("./crash-child.ts", import.meta.url)), db.url, runId, String(N),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const confirmed: string[] = [];
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop()!;
        confirmed.push(...lines.filter(Boolean));
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      // laisse tourner jusqu'à ~200 transactions confirmées, puis tue SANS préavis
      const t0 = Date.now();
      while (confirmed.length < 200 && child.exitCode === null && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
      const exited = new Promise((r) => (child.exitCode !== null ? r(null) : child.on("exit", r)));
      child.kill("SIGKILL");
      await exited;
      expect(stderr).toBe("");
      expect(confirmed.length).toBeGreaterThanOrEqual(200);

      // laisser PostgreSQL annuler les transactions des connexions orphelines
      await new Promise((r) => setTimeout(r, 300));
      const inDb = new Set((await db.pool.query<{ k: string }>(
        "SELECT idempotency_key AS k FROM ledger_transactions WHERE idempotency_key LIKE $1", [`crash:${runId}:%`],
      )).rows.map((r) => r.k));
      for (const k of confirmed) expect(inDb.has(k)).toBe(true); // durabilité : aucune perte
      // au plus quelques commits validés côté base mais pas encore annoncés au moment du kill
      expect(inDb.size - confirmed.length).toBeLessThanOrEqual(6);

      await expectLedgerSound();
      let total = 0;
      for (let i = 0; i < N; i++) total += await ledger.balance(user(`c${i}`), "PLAY");
      const rake = Number((await db.pool.query(
        "SELECT count(*) AS n FROM ledger_transactions WHERE idempotency_key LIKE $1", [`crash:${runId}:%`],
      )).rows[0].n); // 1 centime de commission par virement
      expect(total + rake).toBe(N * 5_000);
    }, 40_000);
  });

  describe("récupération après crash : escrows orphelins", () => {
    it("rembourse à l'identique les mises bloquées d'un duel et d'un tournoi interrompus, une seule fois", async () => {
      for (const u of ["o1", "o2", "o3", "o4"]) await fund(u, 1_000);
      await lockStakes(ledger, "orphan-duel", "PLAY", 300, ["o1", "o2"]);
      const tEscrow = acct.tournamentEscrow("orphan-t", "PLAY");
      for (const [u, n] of [["o3", 1], ["o4", 1], ["o3", 2]] as const) {
        if (u === "o3" && n === 2) {
          await ledger.post(`tunreg:orphan-t:o3:1`, "PLAY", [{ account: tEscrow, amountCents: -500 }, { account: user("o3"), amountCents: 500 }]);
        }
        await ledger.post(`tlock:orphan-t:${u}:${n}`, "PLAY", [{ account: user(u), amountCents: -500 }, { account: tEscrow, amountCents: 500 }]);
      }
      // une partie toujours active ne doit pas être touchée
      await fund("live1", 1000); await fund("live2", 1000);
      await lockStakes(ledger, "live-duel", "PLAY", 100, ["live1", "live2"]);

      // seuls les escrows « orphan-* » sont considérés interrompus (les autres tests de ce fichier ont les leurs)
      const isActive = (a: string) => !a.includes("orphan");
      const refunded = await refundOrphanedEscrows(ledger, isActive);
      expect(refunded.map((r) => r.account).sort()).toEqual([acct.escrow("orphan-duel", "PLAY"), tEscrow].sort());
      for (const u of ["o1", "o2", "o3", "o4"]) expect(await ledger.balance(user(u), "PLAY")).toBe(1_000);
      expect(await ledger.balance(acct.escrow("live-duel", "PLAY"), "PLAY")).toBe(200);
      expect(await refundOrphanedEscrows(ledger, isActive)).toEqual([]); // idempotent
      await expectLedgerSound();
    });
  });
});
