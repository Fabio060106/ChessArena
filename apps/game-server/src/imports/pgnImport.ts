import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import { pgnMainline, pgnPlayerKey, pgnSpeed, splitPgnGames } from "@chessarena/shared";
import type { ImportedGame } from "./lichessImport.js";

/** Au plus autant de parties par envoi (le navigateur découpe les gros fichiers en plusieurs envois). */
export const PGN_IMPORT_MAX_GAMES = 1000;
export const PGN_IMPORT_MAX_BYTES = 1_500_000;

const clean = (s: string | undefined, n: number) => (s ?? "").replace(/["\\\r\n]/g, "").trim().slice(0, n);
const known = (s: string | undefined) => !!s && s !== "?" && !/^\?+$/.test(s);

/** Date PGN (« 2024.03.17 », « 2024.??.?? ») vers ISO ; inconnue : le 1er janvier 2000. */
function isoDate(d: string | undefined): string {
  const m = /^(\d{4})\.(\d{2}|\?\?)\.(\d{2}|\?\?)$/.exec((d ?? "").trim());
  if (!m) return new Date(Date.UTC(2000, 0, 1)).toISOString();
  const mo = m[2] === "??" ? 1 : Number(m[2]), da = m[3] === "??" ? 1 : Number(m[3]);
  const t = Date.UTC(Number(m[1]), Math.min(12, Math.max(1, mo)) - 1, Math.min(31, Math.max(1, da)), 12);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(Date.UTC(2000, 0, 1)).toISOString();
}

/**
 * Lit un fichier PGN (parties de club, export ChessBase…) et garde les parties du joueur :
 * échecs standard depuis la position initiale, avec un résultat, au moins quatre demi-coups lisibles.
 * Seuls les coups, les joueurs, la date et le résultat sont gardés : jamais les commentaires ni les variantes.
 */
export function parsePgnImport(text: string, players: readonly string[]): { games: ImportedGame[]; skipped: number } {
  const keys = new Set(players.map(pgnPlayerKey).filter(Boolean));
  const games: ImportedGame[] = [];
  let skipped = 0;
  for (const g of splitPgnGames(text)) {
    if (games.length >= PGN_IMPORT_MAX_GAMES) { skipped++; continue; }
    const t = g.tags;
    const white = keys.has(pgnPlayerKey(t.White ?? "")), black = keys.has(pgnPlayerKey(t.Black ?? ""));
    const result = (t.Result ?? "").trim();
    if (white === black || !["1-0", "0-1", "1/2-1/2"].includes(result) || (t.SetUp === "1" && t.FEN) || (t.Variant && !/^(standard|chess)$/i.test(t.Variant))) { skipped++; continue; }
    const c = new Chess();
    const sans: string[] = [];
    for (const san of pgnMainline(g.movetext)) {
      try { sans.push(c.move(san).san); } catch { break; }
    }
    if (sans.length < 4) { skipped++; continue; }
    const color: "w" | "b" = white ? "w" : "b";
    const outcome: ImportedGame["outcome"] = result === "1/2-1/2" ? "draw" : (result === "1-0") === white ? "win" : "loss";
    const oppName = clean(white ? t.Black : t.White, 60) || "Adversaire";
    const oppElo = clean(white ? t.BlackElo : t.WhiteElo, 5);
    const tags: Array<[string, string]> = [
      ["Event", clean(t.Event, 80) || "?"], ["Site", clean(t.Site, 80) || "?"], ["Date", clean(t.Date, 10) || "????.??.??"],
      ["Round", clean(t.Round, 10) || "?"], ["White", clean(t.White, 60) || "?"], ["Black", clean(t.Black, 60) || "?"], ["Result", result],
    ];
    for (const k of ["WhiteElo", "BlackElo", "ECO", "Opening", "TimeControl"]) if (known(t[k])) tags.push([k, clean(t[k], 80)]);
    const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
    const pgn = `${tags.map(([k, v]) => `[${k} "${v}"]`).join("\n")}\n\n${body} ${result}\n`;
    if (Buffer.byteLength(pgn) > 20_000) { skipped++; continue; }
    const extId = createHash("sha1").update([t.Date, t.White, t.Black, t.Round, sans.join(" ")].join("|")).digest("hex").slice(0, 24);
    games.push({
      source: "pgn", extId, account: clean(white ? t.White : t.Black, 60) || "PGN", playedAt: isoDate(t.Date),
      color, opponent: `${oppName}${/^\d{3,4}$/.test(oppElo) ? ` (${oppElo})` : ""}`.slice(0, 80), outcome,
      speed: pgnSpeed(t.TimeControl), opening: known(t.Opening) ? clean(t.Opening, 120) : null, pgn,
    });
  }
  return { games, skipped };
}
