import { Chess } from "chess.js";
import type { RelayGameView, RelayStanding } from "@chessarena/shared";
import { normResult } from "./lcc.js";

/**
 * Lichess Broadcast (source de secours) : retransmissions publiques et gratuites.
 * Liens acceptés :
 *  - un tournoi : https://lichess.org/broadcast/<slug>/<tourId>        → la ronde en cours est suivie automatiquement
 *  - une ronde  : https://lichess.org/broadcast/<slug>/<slug>/<roundId>
 * Données : GET /api/broadcast/<tourId> (rondes), GET /api/broadcast/round/<roundId>.pgn (parties, pendules [%clk]).
 */
export const LICHESS = "https://lichess.org";

export type LichessRef = { kind: "tour" | "round"; id: string };

export function parseLichessUrl(raw: string): LichessRef | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/(^|\.)lichess\.org$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("broadcast");
  if (i < 0) return null;
  const rest = parts.slice(i + 1);
  const id = /^[A-Za-z0-9]{8}$/;
  if (rest.length >= 3 && id.test(rest[2]!)) return { kind: "round", id: rest[2]! };
  if (rest.length === 2 && id.test(rest[1]!)) return { kind: "tour", id: rest[1]! };
  return null;
}

/** Codage dans la base : « tour:abcd1234 » / « round:abcd1234 ». */
export const encodeLichess = (r: LichessRef) => `${r.kind}:${r.id}`;
export function decodeLichess(s: string): LichessRef | null {
  const m = /^(tour|round):([A-Za-z0-9]{8})$/.exec(s);
  return m ? { kind: m[1] as "tour" | "round", id: m[2]! } : null;
}

export interface LichessTour { tour?: { name?: string }; rounds?: Array<{ id?: string; name?: string; ongoing?: boolean; finished?: boolean; startsAt?: number }> }
export interface LichessRoundInfo { round?: { id?: string; name?: string }; tour?: { name?: string } }

/**
 * Ronde à suivre : celle en cours ; sinon la prochaine dont l'heure de début est passée
 * (la partie va commencer : on l'affiche dès le premier coup) ; sinon la dernière terminée ; sinon la première.
 * `soon` : une ronde commence dans moins de 10 min (ou vient de commencer) → relire le tournoi plus souvent.
 */
export function pickLichessRound(t: LichessTour, now = Date.now()): { id: string; name: string; number: number; soon: boolean } | null {
  const rounds = (t.rounds ?? []).filter((r) => typeof r.id === "string");
  if (!rounds.length) return null;
  const starting = (r: (typeof rounds)[number]) => !r.ongoing && !r.finished && typeof r.startsAt === "number";
  const soon = rounds.some((r) => starting(r) && r.startsAt! - now < 10 * 60_000 && now - r.startsAt! < 3 * 3600_000);
  let i = rounds.findIndex((r) => r.ongoing);
  if (i < 0) i = rounds.findIndex((r) => starting(r) && r.startsAt! <= now && now - r.startsAt! < 3 * 3600_000);
  if (i < 0) for (let k = rounds.length - 1; k >= 0; k--) if (rounds[k]!.finished) { i = k; break; }
  if (i < 0) i = 0;
  return { id: rounds[i]!.id!, name: rounds[i]!.name ?? `Ronde ${i + 1}`, number: i + 1, soon };
}

const clk = (comment: string): number | null => {
  const m = /\[%clk (\d+):(\d{2}):(\d{2})(?:\.\d+)?\]/.exec(comment);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/** PGN d'une ronde (plusieurs parties) → vues ChessAurum. Une partie illisible est ignorée, pas les autres. */
export function lichessPgnGames(pgn: string, now: number): RelayGameView[] {
  const chunks = pgn.replace(/\r/g, "").split(/\n\s*\n(?=\[)/).reduce<string[]>((acc, part) => {
    // un en-tête + ses coups forment une partie : on recolle les blocs « coups » au bloc d'en-tête précédent
    if (/^\s*\[Event /.test(part) || !acc.length) acc.push(part); else acc[acc.length - 1] += `\n\n${part}`;
    return acc;
  }, []);
  const out: RelayGameView[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const c = new Chess();
    try { c.loadPgn(chunk, { strict: false }); } catch { continue; }
    const h = c.getHeaders();
    const hist = c.history({ verbose: true });
    const comments = new Map(c.getComments().map((x) => [x.fen, x.comment]));
    const clocks: { w: number | null; b: number | null } = { w: null, b: null };
    for (const m of hist) {
      const t = clk(comments.get(m.after) ?? "");
      if (t !== null) clocks[m.color] = t;
    }
    // FEN de départ particulière (Chess960…) : non gérée par l'échiquier de suivi, on ignore la partie
    if (h.FEN && h.SetUp === "1") continue;
    const result = normResult(h.Result);
    out.push({
      index: out.length + 1,
      white: { name: h.White && h.White !== "?" ? h.White : "?", title: h.WhiteTitle || null, fideId: Number(h.WhiteFideId) || null },
      black: { name: h.Black && h.Black !== "?" ? h.Black : "?", title: h.BlackTitle || null, fideId: Number(h.BlackFideId) || null },
      result,
      live: result === null && hist.length > 0,
      sans: hist.map((m) => m.san),
      ucis: hist.map((m) => m.from + m.to + (m.promotion ?? "")),
      fen: c.fen(),
      clocks,
      clockAt: now,
      turn: c.turn(),
    });
  }
  return out;
}

/** Classement à partir des parties terminées (1 point la victoire, ½ la nulle). */
export function standingsOf(games: readonly RelayGameView[]): RelayStanding[] {
  const t = new Map<string, RelayStanding>();
  const add = (p: RelayGameView["white"], pts: number) => {
    const k = p.fideId ? `f${p.fideId}` : p.name;
    const row = t.get(k) ?? { name: p.name, title: p.title, score: 0, played: 0 };
    row.score += pts; row.played++; t.set(k, row);
  };
  for (const g of games) {
    if (!g.result || g.white.name === "?" || g.black.name === "?") continue;
    const w = g.result === "1-0" ? 1 : g.result === "0-1" ? 0 : 0.5;
    add(g.white, w); add(g.black, 1 - w);
  }
  return [...t.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 50);
}
