import {
  TIME_CONTROLS,
  type ClientSignalPayload, type MovePayload, type QueueJoinPayload, type TimeControlId,
} from "@chessarena/shared";

/**
 * Validation des payloads entrants. Tout ce qui vient d'un socket est `unknown`
 * jusqu'à preuve du contraire. Type guards écrits à la main (pas de dépendance)
 * pour rester sous la microseconde dans le chemin chaud.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

export function parseQueueJoin(p: unknown): QueueJoinPayload | null {
  if (!isObj(p) || !isObj(p.stake)) return null;
  const tc = p.timeControl;
  if (typeof tc !== "string" || !(tc in TIME_CONTROLS)) return null;
  const { currency, buyInCents } = p.stake;
  if (currency !== "PLAY" && currency !== "EUR") return null;
  if (typeof buyInCents !== "number" || !Number.isSafeInteger(buyInCents) || buyInCents < 0) return null;
  return { timeControl: tc as TimeControlId, stake: { currency, buyInCents } };
}

export function parseMove(p: unknown): MovePayload | null {
  if (!isObj(p) || !isId(p.gameId)) return null;
  if (typeof p.uci !== "string" || p.uci.length < 4 || p.uci.length > 5) return null;
  if (typeof p.ply !== "number" || !Number.isInteger(p.ply) || p.ply < 0 || p.ply > 2000) return null;
  return { gameId: p.gameId, uci: p.uci, ply: p.ply };
}

export function parseGameRef(p: unknown): { gameId: string } | null {
  return isObj(p) && isId(p.gameId) ? { gameId: p.gameId } : null;
}

export function parseSignal(p: unknown): ClientSignalPayload | null {
  if (!isObj(p) || !isId(p.gameId)) return null;
  if (p.kind !== "focus_lost" && p.kind !== "focus_regained") return null;
  return { gameId: p.gameId, kind: p.kind, clientTs: typeof p.clientTs === "number" ? p.clientTs : 0 };
}
