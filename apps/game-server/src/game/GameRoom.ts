import { Chess } from "chess.js";
import { randomUUID } from "node:crypto";
import type {
  Color, ErrorCode, GameResult, GameStateEvent, PresenceEvent, Stake, Termination, TimeControl,
} from "@chessarena/shared";
import { ServerClock } from "./clock.js";

export interface Seat {
  userId: string;
  rating: number;
}

export interface FinishedGame {
  gameId: string;
  white: Seat;
  black: Seat;
  timeControl: TimeControl;
  stake: Stake;
  result: GameResult;
  termination: Termination;
  pgn: string;
  /** temps facturé par demi-coup (ms) — 0 pour les deux premiers */
  moveTimesMs: number[];
  focusLoss: Record<Color, number>;
  /** true = partie annulée : remboursement intégral, pas de rake, pas d'Elo */
  aborted: boolean;
  /** si annulée : camp responsable (n'a pas joué son 1er coup, a quitté, a abandonné trop tôt) */
  abortedBy: Color | null;
  /** partie comptant pour le classement Elo */
  rated: boolean;
  /** partie de tournoi (routage du résultat vers le moteur Sit & Go) */
  tournament: TournamentGameRef | null;
}

export interface TournamentGameRef {
  tournamentId: string;
  round: number;
  slot: number;
  kind: "main" | "rematch" | "armageddon";
}

export interface RoomHooks {
  onState(state: GameStateEvent): void;
  onMove(gameId: string, ply: number, uci: string, san: string, chargedMs: number): void;
  onPresence(p: PresenceEvent): void;
  onFinish(game: FinishedGame): void;
}

export interface GameRoomOptions {
  white: Seat;
  black: Seat;
  timeControl: TimeControl;
  stake: Stake;
  hooks: RoomHooks;
  firstMoveTimeoutMs: number;
  disconnectGraceMs: number;
  /** tests uniquement : position de départ */
  initialFen?: string;
  id?: string;
  /** défaut : true */
  rated?: boolean;
  tournament?: TournamentGameRef | null;
  now?: () => number;
}

/** Nombre de demi-coups en dessous duquel une partie est annulée plutôt que perdue. */
export const ABORT_PLY_THRESHOLD = 2;

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Une partie 1v1. Le serveur est l'unique autorité :
 *  - légalité : chess.js (ADR-3) ;
 *  - temps : ServerClock (ADR-8) ;
 *  - fin de partie : décidée ici, jamais sur déclaration d'un client.
 *
 * Toutes les méthodes publiques sont idempotentes après la fin de partie.
 */
export class GameRoom {
  readonly id: string;
  readonly white: Seat;
  readonly black: Seat;
  readonly timeControl: TimeControl;
  readonly stake: Stake;

  private readonly chess: Chess;
  private readonly clock: ServerClock;
  private readonly hooks: RoomHooks;
  private readonly firstMoveTimeoutMs: number;
  private readonly disconnectGraceMs: number;
  private readonly now: () => number;
  private readonly rated: boolean;
  private readonly tournament: TournamentGameRef | null;

  private moveTimes: number[] = [];
  private focusLoss: Record<Color, number> = { w: 0, b: 0 };
  private finished = false;
  private lastMoveUci: string | null = null;
  private abortTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimers: Partial<Record<Color, { timer: ReturnType<typeof setTimeout>; deadline: number }>> = {};

  constructor(o: GameRoomOptions) {
    this.id = o.id ?? randomUUID();
    this.white = o.white;
    this.black = o.black;
    this.timeControl = o.timeControl;
    this.stake = o.stake;
    this.hooks = o.hooks;
    this.firstMoveTimeoutMs = o.firstMoveTimeoutMs;
    this.disconnectGraceMs = o.disconnectGraceMs;
    this.now = o.now ?? (() => Date.now());
    this.rated = o.rated ?? true;
    this.tournament = o.tournament ?? null;
    this.chess = new Chess(o.initialFen);
    this.clock = new ServerClock(o.timeControl, (c) => this.onFlag(c), this.now);
    this.chess.header(
      "Event", `ChessArena ${o.timeControl.id}`,
      "Site", "ChessArena",
      "Date", new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, "."),
      "White", o.white.userId, "Black", o.black.userId,
      "WhiteElo", String(o.white.rating), "BlackElo", String(o.black.rating),
      "TimeControl", `${o.timeControl.initialMs / 1000}+${o.timeControl.incrementMs / 1000}`,
    );
    this.armAbortTimer();
  }

  // ─── Lecture ───────────────────────────────────────────────────────────────
  colorOf(userId: string): Color | null {
    if (userId === this.white.userId) return "w";
    if (userId === this.black.userId) return "b";
    return null;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get ply(): number {
    return this.moveTimes.length;
  }

  get fen(): string {
    return this.chess.fen();
  }

  state(): GameStateEvent {
    const t = this.clock.snapshot();
    return {
      gameId: this.id, fen: this.chess.fen(), lastMoveUci: this.lastMoveUci, ply: this.ply,
      whiteMs: t.w, blackMs: t.b, turn: this.chess.turn(), serverTs: this.now(),
    };
  }

  // ─── Coups ─────────────────────────────────────────────────────────────────
  /**
   * Joue un coup. Retourne `null` si accepté, sinon un code d'erreur.
   * Ordre des contrôles = du moins cher au plus cher ; le coup n'est appliqué
   * qu'APRÈS la pendule, pour qu'un coup arrivé drapeau tombé n'entre jamais au PGN.
   */
  play(userId: string, uci: string, expectedPly: number, lagMs = 0): ErrorCode | null {
    if (this.finished) return "GAME_OVER";
    const color = this.colorOf(userId);
    if (!color) return "NOT_A_PLAYER";
    if (typeof uci !== "string" || !UCI_RE.test(uci)) return "BAD_FORMAT";
    if (this.chess.turn() !== color) return "NOT_YOUR_TURN";
    if (expectedPly !== this.ply) return "STALE_PLY";

    const at = this.now();
    const plyBefore = this.ply;

    // 1) Drapeau d'abord : un coup arrivé après la chute n'est jamais appliqué.
    if (plyBefore >= ABORT_PLY_THRESHOLD && this.clock.wouldFlag(color, lagMs, at)) {
      this.clock.press(color, lagMs, at); // déclenche onFlag → fin de partie
      return "FLAGGED";
    }

    // 2) Légalité (ADR-3). move({from,to}) ne génère que les coups légaux internes,
    //    sans SAN pour chacun : ~30× moins cher que moves({ verbose: true }).
    const promotion = uci[4];
    let san: string;
    try {
      const m = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion });
      // chess.js ignore une pièce de promotion superflue ("e2e4q") : on la refuse.
      if ((m.promotion ?? undefined) !== promotion) {
        this.chess.undo();
        return "ILLEGAL_MOVE";
      }
      san = m.san;
    } catch {
      return "ILLEGAL_MOVE";
    }

    // 3) Pendule. Les 2 premiers demi-coups ne sont pas chronométrés (convention Lichess).
    let charged = 0;
    if (plyBefore === 0) {
      this.armAbortTimer(); // les Noirs ont à leur tour firstMoveTimeoutMs
    } else if (plyBefore === 1) {
      this.clearAbortTimer();
      this.clock.start("w");
    } else {
      charged = this.clock.press(color, lagMs, at) ?? 0; // non nul : wouldFlag vient d'être vérifié au même instant
    }

    this.moveTimes.push(charged);
    this.lastMoveUci = uci;
    this.hooks.onMove(this.id, this.ply, uci, san, charged);

    const end = this.detectBoardEnd();
    if (end) this.finish(end[0], end[1]);
    else this.hooks.onState(this.state());
    return null;
  }

  resign(userId: string): void {
    const c = this.colorOf(userId);
    if (!c || this.finished) return;
    if (this.ply < ABORT_PLY_THRESHOLD) return this.finish("1/2-1/2", "aborted", c);
    this.finish(c === "w" ? "0-1" : "1-0", "resignation");
  }

  recordFocusLoss(userId: string): void {
    const c = this.colorOf(userId);
    if (c && !this.finished) this.focusLoss[c]++;
  }

  // ─── Présence ──────────────────────────────────────────────────────────────
  /** Le joueur n'a plus aucun socket : on arme la grâce. La pendule CONTINUE de tourner. */
  disconnect(userId: string): void {
    const c = this.colorOf(userId);
    if (!c || this.finished || this.graceTimers[c]) return;
    const deadline = this.now() + this.disconnectGraceMs;
    const timer = setTimeout(() => this.forfeit(c), this.disconnectGraceMs);
    this.graceTimers[c] = { timer, deadline };
    this.hooks.onPresence({ gameId: this.id, userId, connected: false, graceMs: this.disconnectGraceMs });
  }

  reconnect(userId: string): void {
    const c = this.colorOf(userId);
    if (!c || this.finished) return;
    const g = this.graceTimers[c];
    if (!g) return;
    clearTimeout(g.timer);
    delete this.graceTimers[c];
    this.hooks.onPresence({ gameId: this.id, userId, connected: true, graceMs: 0 });
  }

  graceRemainingMs(userId: string): number | null {
    const c = this.colorOf(userId);
    const g = c ? this.graceTimers[c] : undefined;
    return g ? Math.max(0, g.deadline - this.now()) : null;
  }

  /** Arrêt du serveur : annule proprement sans règlement. */
  dispose(): void {
    this.clearAllTimers();
    this.finished = true;
  }

  // ─── Fin de partie ─────────────────────────────────────────────────────────
  private forfeit(c: Color): void {
    delete this.graceTimers[c];
    if (this.finished) return;
    if (this.ply < ABORT_PLY_THRESHOLD) return this.finish("1/2-1/2", "aborted", c);
    this.finish(c === "w" ? "0-1" : "1-0", "abandon");
  }

  private onFlag(color: Color): void {
    if (this.finished) return;
    const opponent: Color = color === "w" ? "b" : "w";
    // FIDE 6.9 (simplifié) : si l'adversaire ne peut pas mater (roi seul), nulle.
    if (this.hasOnlyKing(opponent)) return this.finish("1/2-1/2", "timeout_vs_insufficient_material");
    this.finish(color === "w" ? "0-1" : "1-0", "timeout");
  }

  private hasOnlyKing(color: Color): boolean {
    let n = 0;
    for (const row of this.chess.board()) for (const sq of row) if (sq && sq.color === color) n++;
    return n === 1;
  }

  /**
   * Détection de fin après un coup. Une seule génération de coups légaux :
   * isGameOver() de chess.js en ferait deux (mat ET pat).
   */
  private detectBoardEnd(): [GameResult, Termination] | null {
    const c = this.chess;
    if (c.isCheck()) {
      if (c.isCheckmate()) return [c.turn() === "w" ? "0-1" : "1-0", "checkmate"];
    } else if (c.isStalemate()) {
      return ["1/2-1/2", "stalemate"];
    }
    if (c.isInsufficientMaterial()) return ["1/2-1/2", "insufficient_material"];
    if (c.isThreefoldRepetition()) return ["1/2-1/2", "repetition"];
    if (c.isDrawByFiftyMoves()) return ["1/2-1/2", "fifty_moves"];
    return null;
  }

  private finish(result: GameResult, termination: Termination, abortedBy: Color | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.clearAllTimers();
    this.chess.header("Result", result, "Termination", termination);
    this.hooks.onFinish({
      gameId: this.id, white: this.white, black: this.black, timeControl: this.timeControl,
      stake: this.stake, result, termination, pgn: this.chess.pgn(),
      moveTimesMs: [...this.moveTimes], focusLoss: { ...this.focusLoss },
      aborted: termination === "aborted",
      abortedBy: termination === "aborted" ? abortedBy : null,
      rated: this.rated && termination !== "aborted",
      tournament: this.tournament,
    });
  }

  // ─── Timers ────────────────────────────────────────────────────────────────
  private armAbortTimer(): void {
    this.clearAbortTimer();
    // responsable : le camp au trait qui n'a pas joué son premier coup
    this.abortTimer = setTimeout(() => this.finish("1/2-1/2", "aborted", this.chess.turn()), this.firstMoveTimeoutMs);
  }

  private clearAbortTimer(): void {
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.abortTimer = null;
  }

  private clearAllTimers(): void {
    this.clock.stop();
    this.clearAbortTimer();
    for (const g of Object.values(this.graceTimers)) if (g) clearTimeout(g.timer);
    this.graceTimers = {};
  }
}
