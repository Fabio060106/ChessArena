import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS_DIR } from "../../src/db/migrate.js";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";

describe.skipIf(!pgAvailable())("migrations", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.drop(); });

  it("sont idempotentes", async () => {
    expect(await migrate(db.url)).toEqual([]);
    const r = await db.pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(r.rows.map((x) => x.name)).toContain("001_init.sql");
  });

  it("refusent une migration modifiée après application", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-")) + "/";
    copyFileSync(join(MIGRATIONS_DIR, "001_init.sql"), dir + "001_init.sql");
    writeFileSync(dir + "001_init.sql", "-- modifié\n", { flag: "a" });
    await expect(migrate(db.url, dir)).rejects.toThrow(/modifiée après application/);
  });
});
