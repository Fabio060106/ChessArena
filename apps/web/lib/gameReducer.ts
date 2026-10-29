import type {
  Color, ErrorCode, GameOverEvent, GameStartEvent, GameStateEvent, PresenceEvent, SessionModeEvent, Stake, TimeControlId,
} from "@chessarena/shared";
import type { Premove } from "./moves";

/**
 * Machine à états de la partie côté client. Pure → testée sans React ni socket.
 *
 *   connecting → idle ⇄ queued → playing → over → (idle | queued)
 *
 * Deux FEN coexistent :
 *  - serverFen : dernière position confirmée par le serveur (vérité) ;
 *  - displayFen : position affichée, qui inclut un coup optimiste en attente d'ack.
 */
export type Phase = "connecting" | "idle" | "queued" | "playing" | "over";

export interface PendingMove {
  uci: string;
  ply: number;
  fen: string;
}

export interface GameView {
  phase: Phase;
  connected: boolean;
  queue: { timeControl: TimeControlId; stake: Stake } | null;
  start: GameStartEvent | null;
  server: GameStateEvent | null;
  displayFen: string;
  lastMove: string | null;
  myColor: Color;
  pending: PendingMove | null;
  premove: Premove | null;
  opponentPresence: PresenceEvent | null;
  over: GameOverEvent | null;
  error: ErrorCode | null;
  /** mode de session imposé par le serveur (géo-filtre, kill-switch, auto-exclusion) */
  session: SessionModeEvent | null;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const initialView: GameView = {
  phase: "connecting", connected: false, queue: null, start: null, server: null,
  displayFen: START_FEN, lastMove: null, myColor: "w", pending: null, premove: null,
  opponentPresence: null, over: null, error: null, session: null,
};

export type GameAction =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "queued"; timeControl: TimeControlId; stake: Stake }
  | { type: "queue_left" }
  | { type: "start"; start: GameStartEvent; userId: string }
  | { type: "state"; state: GameStateEvent }
  | { type: "optimistic_move"; pending: PendingMove }
  | { type: "move_rejected"; code: ErrorCode }
  | { type: "move_acked"; ply: number }
  | { type: "set_premove"; premove: Premove | null }
  | { type: "presence"; presence: PresenceEvent; userId: string }
  | { type: "over"; over: GameOverEvent }
  | { type: "error"; code: ErrorCode }
  | { type: "session_mode"; session: SessionModeEvent }
  | { type: "clear_error" };

export function gameReducer(s: GameView, a: GameAction): GameView {
  switch (a.type) {
    case "connected":
      return { ...s, connected: true, phase: s.phase === "connecting" ? "idle" : s.phase };
    case "disconnected":
      // la file est vidée côté serveur au dernier socket fermé ; la partie, elle, attend 30 s
      return { ...s, connected: false, queue: null, phase: s.phase === "queued" ? "idle" : s.phase, pending: null };
    case "queued":
      return { ...s, phase: "queued", queue: { timeControl: a.timeControl, stake: a.stake }, error: null };
    case "queue_left":
      return s.phase === "queued" ? { ...s, phase: "idle", queue: null } : s;
    case "start": {
      const myColor: Color = a.start.black.userId === a.userId ? "b" : "w";
      const sameGame = s.start?.gameId === a.start.gameId; // resynchro après reconnexion
      return {
        ...s, phase: "playing", queue: null, start: a.start, myColor, over: null, error: null,
        server: sameGame ? s.server : null,
        displayFen: sameGame ? s.displayFen : a.start.fen,
        lastMove: sameGame ? s.lastMove : null,
        pending: null, premove: sameGame ? s.premove : null, opponentPresence: null,
      };
    }
    case "state": {
      if (!s.start || a.state.gameId !== s.start.gameId) return s;
      if (s.server && a.state.ply < s.server.ply) return s; // état périmé arrivé en retard
      // L'état serveur fait foi : s'il confirme le coup en attente, l'affichage ne bouge pas.
      return { ...s, server: a.state, displayFen: a.state.fen, lastMove: a.state.lastMoveUci, pending: null };
    }
    case "optimistic_move":
      return { ...s, pending: a.pending, displayFen: a.pending.fen, lastMove: a.pending.uci, premove: null };
    case "move_rejected":
      // rollback vers la dernière vérité serveur
      return {
        ...s, pending: null, displayFen: s.server?.fen ?? s.displayFen,
        lastMove: s.server?.lastMoveUci ?? null, error: a.code === "STALE_PLY" ? s.error : a.code,
      };
    case "move_acked":
      return s.pending && a.ply === s.pending.ply + 1 ? { ...s, pending: null } : s;
    case "set_premove":
      return { ...s, premove: a.premove };
    case "presence":
      return a.presence.userId === a.userId ? s : { ...s, opponentPresence: a.presence.connected ? null : a.presence };
    case "over":
      if (!s.start || a.over.gameId !== s.start.gameId) return s;
      return { ...s, phase: "over", over: a.over, pending: null, premove: null, opponentPresence: null };
    case "error":
      return { ...s, error: a.code, phase: s.phase === "queued" && isQueueError(a.code) ? "idle" : s.phase };
    case "session_mode":
      return { ...s, session: a.session };
    case "clear_error":
      return { ...s, error: null };
  }
}

function isQueueError(c: ErrorCode): boolean {
  return ["BAD_STAKE", "BAD_PAYLOAD", "REAL_MONEY_DISABLED", "JURISDICTION_BLOCKED",
    "KYC_REQUIRED_OR_ACCOUNT_HELD", "ACCOUNT_SUSPENDED", "STAKE_LOCK_FAILED",
    "SELF_EXCLUDED", "LIMIT_EXCEEDED", "LIMITS_REQUIRED", "PLAY_MONEY_ONLY"].includes(c);
}

/** Libellé du bandeau de mode de session (null = rien à afficher). */
export function sessionBanner(m: SessionModeEvent | null): string | null {
  if (!m || m.mode === "REAL_MONEY") return null;
  if (m.mode === "LOCKED") return "Auto-exclusion en cours : le jeu est suspendu. Vous pouvez consulter votre compte et retirer votre solde.";
  switch (m.reason) {
    case "REAL_MONEY_DISABLED": return "Le jeu en argent réel est momentanément indisponible. Parties en jetons uniquement.";
    case "JURISDICTION_BLOCKED":
    case "RESIDENCE_BLOCKED": return "Le jeu en argent réel n'est pas autorisé dans votre juridiction. Parties en jetons uniquement.";
    default: return "Localisation impossible à vérifier : parties en jetons uniquement.";
  }
}

export function isMyTurn(s: GameView): boolean {
  return s.phase === "playing" && !!s.server && s.server.turn === s.myColor && !s.pending;
}

/** Messages affichables, en français. Jamais le message brut du serveur. */
export const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHORIZED: "Session expirée, reconnectez-vous.",
  RATE_LIMITED: "Trop d'actions, ralentissez.",
  REAL_MONEY_DISABLED: "Le jeu en argent réel n'est pas disponible.",
  JURISDICTION_BLOCKED: "Le jeu en argent réel n'est pas disponible dans votre pays.",
  KYC_REQUIRED_OR_ACCOUNT_HELD: "Vérification d'identité requise.",
  ACCOUNT_SUSPENDED: "Votre compte est suspendu.",
  BAD_STAKE: "Mise non autorisée.",
  IN_GAME: "Vous avez déjà une partie en cours.",
  ALREADY_QUEUED: "Vous êtes déjà en file d'attente.",
  STAKE_LOCK_FAILED: "Solde insuffisant pour cette mise.",
  ILLEGAL_MOVE: "Coup illégal.",
  NOT_YOUR_TURN: "Ce n'est pas votre tour.",
  FLAGGED: "Temps écoulé.",
  SELF_EXCLUDED: "Auto-exclusion en cours : le jeu est suspendu.",
  LIMIT_EXCEEDED: "Cette mise dépasse une de vos limites de jeu.",
  LIMITS_REQUIRED: "Définissez vos limites de jeu avant de miser.",
  PLAY_MONEY_ONLY: "Parties en jetons uniquement depuis votre position actuelle.",
};
