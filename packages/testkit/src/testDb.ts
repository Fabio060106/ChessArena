import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import "./context.js";
import { migrate } from "../../../apps/game-server/src/db/migrate.js";

export const pgAvailable = (): boolean => !!inject("pgAdminUrl");

export interface TestDb {
  url: string;
  pool: pg.Pool;
  /** exécute du SQL en superutilisateur (ex. désactiver un trigger pour simuler une falsification) */
  admin: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
  drop: () => Promise<void>;
}

/** Base fraîche et migrée, propre à un fichier de test (les fichiers tournent en parallèle). */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 40 });
  pool.on("error", () => {}); // connexions tuées volontairement par les tests de crash

  return {
    url,
    pool,
    admin: (sql, params) => pool.query(sql, params as unknown[]),
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
