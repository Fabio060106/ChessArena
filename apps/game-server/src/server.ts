import { loadConfig } from "./config.js";
import { createGameServer } from "./app.js";

const cfg = loadConfig();
const server = createGameServer(cfg);
const port = await server.listen();

console.log(
  `[game-server] :${port} — auth=${cfg.devAuth ? "DEV" : "JWT"} — ledger=${cfg.databaseUrl ? "postgres" : "mémoire"}`
  + ` — argent réel=${cfg.realMoneyEnabled ? `ON (${cfg.realMoneyCountries.join(",") || "aucun pays"})` : "OFF"}`,
);

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`[game-server] ${sig} — arrêt`);
    await server.close();
    process.exit(0);
  });
}
