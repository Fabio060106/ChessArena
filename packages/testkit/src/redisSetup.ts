/**
 * Vitest globalSetup : fournit un Redis réel (BullMQ exécute des scripts Lua :
 * aucun mock n'est fiable).
 *
 *  1. TEST_REDIS_URL défini → utilisé tel quel ;
 *  2. sinon `redis-server` est lancé sur un port libre, sans persistance ;
 *  3. sinon les suites Redis sont sautées avec un message explicite.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { TestProject } from "vitest/node";
import "./context.js";


const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});

export default async function setup(project: TestProject) {
  if (process.env.TEST_REDIS_URL) {
    project.provide("redisUrl", process.env.TEST_REDIS_URL);
    return;
  }
  const bin = process.env.REDIS_BIN ?? "redis-server";
  if (spawnSync(bin, ["--version"]).status !== 0) {
    console.warn("[redis] redis-server introuvable et TEST_REDIS_URL absent : suites Redis sautées");
    project.provide("redisUrl", "");
    return;
  }
  const port = await freePort();
  const child: ChildProcess = spawn(bin, [
    "--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no",
    // BullMQ exige que Redis n'évince jamais ses clés
    "--maxmemory-policy", "noeviction",
  ], { stdio: "ignore" });
  // attendre que le port réponde
  const { Socket } = await import("node:net");
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => {
      const s = new Socket();
      s.once("connect", () => { s.destroy(); r(true); }).once("error", () => r(false)).connect(port, "127.0.0.1");
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  project.provide("redisUrl", `redis://127.0.0.1:${port}`);
  return () => { child.kill("SIGKILL"); };
}
