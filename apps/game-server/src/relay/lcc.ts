import { Chess } from "chess.js";
import type { RelayGameView, RelayPlayer } from "@chessarena/shared";

/**
 * LiveChessCloud (DGT) : la source des échiquiers électroniques des grands tournois.
 * Lien public d'un tournoi : https://view.livechesscloud.com/#<uuid>[/<ronde>]
 * Données JSON (format repris de la lecture qu'en fait Lichess) :
 *  - <pool>/get/<uuid>/tournament.json           { name, rounds: [{ count, live }] }
 *  - <pool>/get/<uuid>/round-<n>/index.json      { date, pairings: [{ white, black, result, live }] }
 *  - <pool>/get/<uuid>/round-<n>/game-<k>.json   { moves: ["e4 5400+12", …], result, clock: { white, black, time } }
 */
export const LCC_POOL = "http://1.pool.livechesscloud.com";

export interface LccRef { id: string; round: number }

/** Lit un lien LiveChessCloud (avec ou sans ronde ; ronde 0 = suivre la plus récente). */
export function parseLccUrl(raw: string): LccRef | null {
  const m = /livechesscloud\.com\/?#?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(\d{1,3}))?/i.exec(raw.trim())
    ?? /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(\d{1,3}))?$/i.exec(raw.trim());
  if (!m) return null;
  return { id: m[1]!.toLowerCase(), round: m[2] ? Number(m[2]) : 0 };
}

export const lccUrls = (id: string, pool = LCC_POOL) => ({
  tournament: `${pool}/get/${id}/tournament.json`,
  index: (round: number) => `${pool}/get/${id}/round-${round}/index.json`,
  game: (round: number, game: number) => `${pool}/get/${id}/round-${round}/game-${game}.json`,
});

export interface LccPairingPlayer { fname?: string | null; mname?: string | null; lname?: string | null; title?: string | null; fideid?: number | null }
export interface LccPairing { live?: boolean; white?: LccPairingPlayer | null; black?: LccPairingPlayer | null; result?: string | null }
export interface LccRound { date?: string | null; pairings?: LccPairing[] }
export interface LccTournament { name?: string | null; rounds?: Array<{ count?: number; live?: number }> }
export interface LccGame { moves?: string[]; result?: string | null; clock?: { white?: number | null; black?: number | null; time?: number } | null; chess960?: number | null; live?: boolean }

export function lccPlayer(p: LccPairingPlayer | null | undefined): RelayPlayer {
  const name = [p?.fname, p?.mname, p?.lname].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" ").trim();
  return {
    name: name || "?",
    title: typeof p?.title === "string" && p.title.trim() ? p.title.trim().slice(0, 4) : null,
    fideId: typeof p?.fideid === "number" && p.fideid > 0 ? p.fideid : null,
  };
}

/** Résultat normalisé ; tout le reste (« * », « NOTPLAYED », vide) = pas de résultat. */
export function normResult(r: string | null | undefined): string | null {
  if (!r) return null;
  const x = r.replace(/\s/g, "").replace(/½/g, "1/2");
  if (x === "1-0" || x === "WHITEWIN") return "1-0";
  if (x === "0-1" || x === "BLACKWIN") return "0-1";
  if (x === "1/2-1/2" || x === "1/2" || x === "DRAW") return "1/2-1/2";
  return null;
}

/** « dxe4 63 », « fxe4 +31 », « Nc2 34+2 » → coup, secondes restantes, temps passé. */
export function parseLccMove(s: string): { san: string; clock: number | null } {
  const [san = "", t] = s.trim().split(/\s+/);
  let clock: number | null = null;
  if (t) {
    const [c] = t.split("+");
    if (c && /^\d+$/.test(c)) clock = Number(c);
  }
  return { san, clock };
}

/**
 * Une partie LiveChessCloud → vue ChessAurum. Les coups illisibles (saisie DGT ratée) arrêtent la lecture :
 * on affiche la partie jusqu'au dernier coup valide, comme le font les autres sites.
 */
export function lccGameView(index: number, pairing: LccPairing, game: LccGame | null, now: number): RelayGameView {
  const chess = new Chess();
  const sans: string[] = [];
  const ucis: string[] = [];
  const clocks: { w: number | null; b: number | null } = { w: null, b: null };
  for (const raw of game?.moves ?? []) {
    if (typeof raw !== "string") break;
    const { san, clock } = parseLccMove(raw);
    const mover = chess.turn();
    let m;
    try { m = chess.move(san, { strict: false }); } catch { break; }
    sans.push(m.san);
    ucis.push(m.from + m.to + (m.promotion ?? ""));
    if (clock !== null) clocks[mover] = clock;
  }
  // l'horloge envoyée à part est plus fiable que celle du dernier coup (format DGT)
  if (typeof game?.clock?.white === "number") clocks.w = game.clock.white;
  if (typeof game?.clock?.black === "number") clocks.b = game.clock.black;
  const result = normResult(game?.result) ?? normResult(pairing.result);
  const live = result === null && (pairing.live === true || game?.live === true);
  return {
    index,
    white: lccPlayer(pairing.white),
    black: lccPlayer(pairing.black),
    result,
    live,
    sans,
    ucis,
    fen: chess.fen(),
    clocks,
    clockAt: typeof game?.clock?.time === "number" && game.clock.time > 0 ? game.clock.time : now,
    turn: chess.turn(),
  };
}

/**
 * Rondes à essayer en mode automatique, dans l'ordre : celle en cours s'il y en a une,
 * sinon les rondes appariées de la plus récente à la plus ancienne (le service garde la première déjà commencée).
 */
export function roundCandidates(t: LccTournament): number[] {
  const rounds = t.rounds ?? [];
  for (let i = rounds.length - 1; i >= 0; i--) if ((rounds[i]?.live ?? 0) > 0) return [i + 1];
  const out: number[] = [];
  for (let i = rounds.length - 1; i >= 0; i--) if ((rounds[i]?.count ?? 0) > 0) out.push(i + 1);
  return out;
}
