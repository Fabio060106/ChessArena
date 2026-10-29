import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, createZstdDecompress } from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Lecture en flux des exports mensuels de la base ouverte Lichess
 * (https://database.lichess.org — `lichess_db_standard_rated_AAAA-MM.pgn.zst`).
 * Plusieurs dizaines de Go : jamais chargés en mémoire, décompression zstd native.
 *
 * Format : en-têtes [Clé "valeur"], ligne vide, coups avec commentaires
 *   1. e4 { [%eval 0.17] [%clk 0:03:00] } 1... c5 { [%clk 0:03:00] } …
 * `%clk` = temps RESTANT après le coup ; `%eval` présent sur ~6 % des parties.
 */
export interface LichessGame {
  headers: Record<string, string>;
  /** coups SAN, dans l'ordre */
  sans: string[];
  /** temps restant (s) après chaque demi-coup, null si absent */
  clocks: Array<number | null>;
}

export function openPgnStream(path: string): Readable {
  const raw = path === "-" ? process.stdin : createReadStream(path, { highWaterMark: 1 << 20 });
  if (path.endsWith(".zst")) return raw.pipe(createZstdDecompress());
  if (path.endsWith(".gz")) return raw.pipe(createGunzip());
  return raw;
}

const HEADER_RE = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
const CLK_RE = /\[%clk (\d+):(\d{2}):(\d{2}(?:\.\d+)?)\]/;

/** Analyse le texte des coups d'une partie Lichess (SAN + horloges). */
export function parseMovetext(text: string): { sans: string[]; clocks: Array<number | null> } {
  const sans: string[] = [];
  const clocks: Array<number | null> = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "{") {
      const end = text.indexOf("}", i);
      const comment = text.slice(i + 1, end < 0 ? n : end);
      const m = comment.match(CLK_RE);
      if (m && sans.length > 0) clocks[sans.length - 1] = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "(") { // variante : ignorée (absente des exports Lichess, par sûreté)
      let depth = 1;
      i++;
      while (i < n && depth > 0) { if (text[i] === "(") depth++; else if (text[i] === ")") depth--; i++; }
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < n && !/[\s{}()]/.test(text[j]!)) j++;
    const tok = text.slice(i, j);
    i = j;
    if (/^\d+\.+$/.test(tok) || /^\d+\.\.\.$/.test(tok)) continue;            // numéros de coup
    if (tok === "1-0" || tok === "0-1" || tok === "1/2-1/2" || tok === "*") continue;
    if (tok.startsWith("$")) continue;                                         // NAG
    const san = tok.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    if (san) { sans.push(san); clocks.push(null); }
  }
  return { sans, clocks };
}

/** Générateur asynchrone de parties à partir d'un flux PGN. */
export async function* readLichessGames(input: Readable): AsyncGenerator<LichessGame> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let headers: Record<string, string> = {};
  let moves: string[] = [];
  let inMoves = false;
  const flush = function* () {
    if (Object.keys(headers).length && moves.length) {
      const { sans, clocks } = parseMovetext(moves.join(" "));
      yield { headers, sans, clocks };
    }
    headers = {};
    moves = [];
    inMoves = false;
  };
  for await (const line of rl) {
    if (line.startsWith("[")) {
      if (inMoves) yield* flush();
      const m = line.match(HEADER_RE);
      if (m) headers[m[1]!] = m[2]!.replace(/\\"/g, '"');
    } else if (line.trim() === "") {
      if (inMoves) yield* flush();
    } else {
      inMoves = true;
      moves.push(line);
    }
  }
  yield* flush();
}

/** Temps de réflexion par demi-coup (ms) déduits de %clk et de l'incrément. */
export function moveTimesFromClocks(clocks: Array<number | null>, timeControl: string): number[] {
  const [baseStr, incStr] = timeControl.split("+");
  const base = Number(baseStr);
  const inc = Number(incStr ?? 0);
  const last: [number, number] = [base, base];
  return clocks.map((c, i) => {
    const side = i % 2;
    if (c === null || !Number.isFinite(base)) return 0;
    // Lichess : l'horloge affichée après le coup inclut déjà l'incrément
    const spent = last[side]! - c + inc;
    last[side] = c;
    return i < 2 ? 0 : Math.max(0, Math.round(spent * 1000));
  });
}

/** Catégorie Lichess : durée estimée = base + 40 × incrément. */
export function speedOf(timeControl: string): "ultrabullet" | "bullet" | "blitz" | "rapid" | "classical" | "correspondence" {
  if (timeControl === "-") return "correspondence";
  const [b, i] = timeControl.split("+").map(Number);
  const est = (b ?? 0) + 40 * (i ?? 0);
  if (est < 30) return "ultrabullet";
  if (est < 180) return "bullet";
  if (est < 480) return "blitz";
  if (est < 1500) return "rapid";
  return "classical";
}

/** Rebâtit un PGN standard (sans commentaires) pour le moteur d'analyse. */
export function toPgn(g: LichessGame): string {
  const parts: string[] = [];
  g.sans.forEach((s, i) => parts.push(i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s));
  return parts.join(" ") + " *";
}
