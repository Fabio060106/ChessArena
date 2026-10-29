import type pg from "pg";
import type { Ledger } from "../src/settlement/ledger.js";
import { acct } from "../src/settlement/ledger.js";

/**
 * Approvisionne un compte EUR pour un test (hors plafonds de dépôt : `kind: test_seed`).
 * Le garde-fou SQL G3 exige une identité vérifiée : on la marque comme telle.
 */
export async function seedEur(pool: pg.Pool, ledger: Ledger, userId: string, cents: number, key = `seed:${userId}:${cents}:${Math.random()}`) {
  await pool.query("INSERT INTO users (id, username) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING", [userId]);
  await pool.query("UPDATE users SET kyc = 'verified' WHERE id = $1", [userId]);
  await ledger.post(key, "EUR", [
    { account: acct.pspIn(), amountCents: -cents }, { account: acct.user(userId, "EUR"), amountCents: cents },
  ], { kind: "test_seed", userId });
}
