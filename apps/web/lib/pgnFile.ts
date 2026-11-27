import { pgnMainline, pgnPlayerKey, splitPgnGames, type PgnGameText } from "@chessarena/shared";

/** Texte d'un fichier PGN : UTF-8, sinon Windows-1252 (exports ChessBase anciens, accents des noms). */
export function decodePgn(buf: ArrayBuffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}

export interface PgnPlayer { name: string; key: string; games: number }

/** Les joueurs les plus présents du fichier : le premier est presque toujours le propriétaire de la base. */
export function pgnPlayers(games: readonly PgnGameText[], n = 12): PgnPlayer[] {
  const by = new Map<string, PgnPlayer>();
  for (const g of games) for (const name of [g.tags.White, g.tags.Black]) {
    if (!name || name === "?") continue;
    const key = pgnPlayerKey(name);
    if (!key) continue;
    const p = by.get(key) ?? { name, key, games: 0 };
    p.games++;
    by.set(key, p);
  }
  return [...by.values()].sort((a, b) => b.games - a.games).slice(0, n);
}

/**
 * Les parties des joueurs choisis, réécrites sans commentaires ni variantes (coups et en-têtes seulement),
 * regroupées en envois d'au plus `maxBytes` octets.
 */
export function pgnChunks(games: readonly PgnGameText[], keys: ReadonlySet<string>, maxBytes = 1_000_000, maxGames = 900): { chunks: string[]; games: number } {
  const chunks: string[] = [];
  let cur = "", count = 0, total = 0;
  for (const g of games) {
    if (!keys.has(pgnPlayerKey(g.tags.White ?? "")) && !keys.has(pgnPlayerKey(g.tags.Black ?? ""))) continue;
    const sans = pgnMainline(g.movetext);
    if (sans.length < 4) continue;
    const tags = Object.entries(g.tags).filter(([k]) => ["Event", "Site", "Date", "Round", "White", "Black", "Result", "WhiteElo", "BlackElo", "ECO", "Opening", "TimeControl", "SetUp", "FEN", "Variant"].includes(k))
      .map(([k, v]) => `[${k} "${v.replace(/["\\]/g, "")}"]`).join("\n");
    const text = `${tags}\n\n${sans.join(" ")} ${g.tags.Result ?? "*"}\n\n`;
    if (cur && (cur.length + text.length > maxBytes || count >= maxGames)) { chunks.push(cur); cur = ""; count = 0; }
    cur += text; count++; total++;
  }
  if (cur) chunks.push(cur);
  return { chunks, games: total };
}

export { splitPgnGames };
