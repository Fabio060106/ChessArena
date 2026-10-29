import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Moteur pour les tests : binaire natif si STOCKFISH_CMD est défini, sinon le build
 * WASM officiel Stockfish 19 du paquet npm (même protocole UCI, ~10× plus lent).
 */
export function testEngineCommand(): string | null {
  if (process.env.STOCKFISH_CMD) return process.env.STOCKFISH_CMD;
  try {
    const pkg = createRequire(import.meta.url).resolve("stockfish/package.json");
    const js = join(dirname(pkg), "bin", "stockfish-19-lite-single.js");
    return existsSync(js) ? `${process.execPath} ${js}` : null;
  } catch {
    return null;
  }
}
