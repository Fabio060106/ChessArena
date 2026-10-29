import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Runner de migrations minimal et sûr :
 *  - fichiers `db/migrations/NNN_nom.sql` appliqués dans l'ordre, chacun dans sa transaction ;
 *  - verrou consultatif : deux instances qui démarrent ensemble ne migrent pas deux fois ;
 *  - empreinte SHA-256 enregistrée : modifier une migration déjà appliquée est refusé.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
const LOCK_KEY = 727_001; // arbitraire, propre à ChessArena

export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows
        .map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = await readFile(dir + f, "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      const prev = done.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`migration ${f} modifiée après application (checksum différent)`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [f, sum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${f} échouée : ${(e as Error).message}`);
      }
      applied.push(f);
      log(`[migrate] ${f} appliquée`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

// CLI : `npm run db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL manquant");
    process.exit(1);
  }
  migrate(url, MIGRATIONS_DIR, console.log)
    .then((a) => console.log(a.length ? `${a.length} migration(s) appliquée(s)` : "schéma à jour"))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
