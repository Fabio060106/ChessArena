/**
 * Processus « victime » du test de crash : enchaîne des virements aléatoires via
 * PgLedger jusqu'à être tué par SIGKILL. Après chaque COMMIT confirmé, écrit la
 * clé sur stdout : le parent sait ainsi ce qui DOIT être durable.
 *
 *   node --import tsx crash-child.ts <databaseUrl> <runId> <accounts>
 */
import pg from "pg";
import { InsufficientFundsError, PgLedger } from "../../src/settlement/ledger.js";

const [url, runId, nStr] = process.argv.slice(2);
const n = Number(nStr ?? 10);
const pool = new pg.Pool({ connectionString: url, max: 8 });
const ledger = new PgLedger(pool);
let i = 0;

async function worker(w: number): Promise<never> {
  for (;;) {
    const k = `${runId}:${w}:${i++}`;
    const a = Math.floor(Math.random() * n);
    let b = Math.floor(Math.random() * n);
    if (b === a) b = (b + 1) % n;
    const amount = 2 + Math.floor(Math.random() * 300);
    try {
      // lot à 3 jambes (dont un compte maison) : plus d'écritures par transaction = plus
      // de chances que le SIGKILL tombe au milieu d'une transaction
      await ledger.post(`crash:${k}`, "PLAY", [
        { account: `user:c${a}:PLAY`, amountCents: -amount },
        { account: `user:c${b}:PLAY`, amountCents: amount - 1 },
        { account: "house:rake:PLAY", amountCents: 1 },
      ]);
      process.stdout.write(`crash:${k}\n`);
    } catch (e) {
      if (!(e instanceof InsufficientFundsError)) throw e;
    }
  }
}

await Promise.all(Array.from({ length: 6 }, (_, w) => worker(w)));
