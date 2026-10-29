/**
 * Vitest globalSetup : fournit un PostgreSQL réel aux tests d'intégration.
 *
 *  1. TEST_DATABASE_URL défini (CI, docker compose) → utilisé tel quel (doit pouvoir CREATE DATABASE) ;
 *  2. sinon, un cluster jetable est créé avec initdb dans un dossier temporaire
 *     (binaires détectés via PG_BIN, pg_config ou /usr/lib/postgresql/<v>/bin) ;
 *  3. sinon, les suites PostgreSQL sont SAUTÉES avec un message explicite.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import "./context.js";


function findBin(): string | null {
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, "initdb"))) return process.env.PG_BIN;
  try {
    const d = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
    if (existsSync(join(d, "initdb"))) return d;
  } catch { /* pas de pg_config */ }
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    for (const v of readdirSync(base).sort().reverse()) {
      if (existsSync(join(base, v, "bin", "initdb"))) return join(base, v, "bin");
    }
  }
  return null;
}

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});

export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide("pgAdminUrl", process.env.TEST_DATABASE_URL);
    return;
  }
  const bin = findBin();
  if (!bin) {
    console.warn("[pg] aucun PostgreSQL trouvé (ni TEST_DATABASE_URL, ni initdb) : suites PG sautées");
    project.provide("pgAdminUrl", "");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "arena-pg-"));
  chmodSync(dir, 0o777);
  const isRoot = process.getuid?.() === 0;
  // initdb refuse de tourner en root : on délègue à l'utilisateur système postgres
  const run = (cmd: string, args: string[]) => {
    const r = isRoot
      ? spawnSync("runuser", ["-u", "postgres", "--", join(bin, cmd), ...args], { encoding: "utf8" })
      : spawnSync(join(bin, cmd), args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} a échoué : ${r.stderr || r.stdout}`);
  };

  const port = await freePort();
  const data = join(dir, "data");
  run("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync", "-E", "UTF8"]);
  run("pg_ctl", ["-D", data, "-l", join(dir, "log"), "-w", "-o",
    `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=300`, "start"]);
  project.provide("pgAdminUrl", `postgres://postgres@127.0.0.1:${port}/postgres`);

  return () => {
    try { run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]); } catch { /* déjà arrêté */ }
    rmSync(dir, { recursive: true, force: true });
  };
}
