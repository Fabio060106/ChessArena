import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import {
  TIME_CONTROLS, type AnalysisRequest, type ClientToServerEvents, type ServerToClientEvents, type Stake, type TimeControlId,
} from "@chessarena/shared";
import { GameRoom, type FinishedGame, type Seat, type TournamentGameRef } from "./GameRoom.js";
import type { QueueTicket } from "../matchmaking/Matchmaker.js";
import { applySettlement, lockStakes, type Ledger } from "../settlement/ledger.js";
import { settleDuel } from "../settlement/rake.js";
import type { AuditSink } from "../audit/auditLog.js";
import type { GameRepository, RecordedGame } from "../persistence/GameRepository.js";
import type { GameServerConfig } from "../config.js";

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

export const userRoom = (userId: string) => `user:${userId}`;

export interface CreateGameOptions {
  gameId?: string;
  white: Seat;
  black: Seat;
  timeControl: TimeControlId;
  stake: Stake;
  rated?: boolean;
  tournament?: TournamentGameRef | null;
}

/** Réessaie une opération idempotente (règlement, enregistrement) avec backoff. */
async function retry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      console.error(`[game] ${label} échoué (essai ${i}/${attempts}), nouvel essai`, (e as Error).message);
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
}

/**
 * Cycle de vie d'une partie :
 *   appariement → blocage des mises (escrow) → création de la room → jeu
 *   → règlement idempotent → enregistrement + Elo → audit → game:over → tournoi / analyse.
 * Le blocage des mises précède la création : si un joueur n'a pas le solde,
 * la partie n'existe jamais et personne n'est débité (lot atomique).
 */
export class GameManager {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly activeByUser = new Map<string, string>();
  private readonly onFinishedListeners: Array<(g: FinishedGame, rec: RecordedGame | null) => void | Promise<void>> = [];

  constructor(
    private readonly io: IO,
    private readonly ledger: Ledger,
    private readonly audit: AuditSink,
    private readonly repo: GameRepository,
    private readonly cfg: GameServerConfig,
    private readonly submitAnalysis: ((req: AnalysisRequest) => Promise<void>) | null,
  ) {}

  get activeGames(): number {
    return this.rooms.size;
  }

  get(gameId: unknown): GameRoom | undefined {
    return typeof gameId === "string" ? this.rooms.get(gameId) : undefined;
  }

  hasGame(gameId: string): boolean {
    return this.rooms.has(gameId);
  }

  activeGameOf(userId: string): GameRoom | undefined {
    const id = this.activeByUser.get(userId);
    return id ? this.rooms.get(id) : undefined;
  }

  onGameFinished(fn: (g: FinishedGame, rec: RecordedGame | null) => void | Promise<void>): void {
    this.onFinishedListeners.push(fn);
  }

  /** Duel issu du matchmaking : bloque les mises puis crée la partie. */
  async createFromMatch(a: QueueTicket, b: QueueTicket): Promise<GameRoom | null> {
    const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
    const gameId = randomUUID();
    if (a.stake.buyInCents > 0) {
      try {
        await lockStakes(this.ledger, gameId, a.stake.currency, a.stake.buyInCents, [white.userId, black.userId]);
      } catch (e) {
        for (const u of [white.userId, black.userId]) {
          this.io.to(userRoom(u)).emit("error", { code: "STAKE_LOCK_FAILED", message: "Solde insuffisant ou mise refusée" });
        }
        console.warn("[game] blocage des mises échoué", gameId, (e as Error).message);
        return null;
      }
    }
    return this.createGame({
      gameId, timeControl: a.timeControl, stake: a.stake,
      white: { userId: white.userId, rating: white.rating }, black: { userId: black.userId, rating: black.rating },
    });
  }

  /** Création générique (duels et tournois). Les mises éventuelles sont DÉJÀ bloquées. */
  async createGame(o: CreateGameOptions): Promise<GameRoom> {
    const gameId = o.gameId ?? randomUUID();
    const tc = TIME_CONTROLS[o.timeControl];
    const room = new GameRoom({
      id: gameId,
      white: o.white,
      black: o.black,
      timeControl: tc,
      stake: o.stake,
      rated: o.rated ?? true,
      tournament: o.tournament ?? null,
      firstMoveTimeoutMs: this.cfg.firstMoveTimeoutMs,
      disconnectGraceMs: this.cfg.disconnectGraceMs,
      hooks: {
        onState: (s) => this.io.to(gameId).emit("game:state", s),
        onMove: (id, ply, uci, san, chargedMs) => this.audit.append("game.move", { gameId: id, ply, uci, san, chargedMs }),
        onPresence: (p) => this.io.to(gameId).emit("game:presence", p),
        // Règlement hors du chemin chaud : le handler du coup final rend la main tout de suite.
        onFinish: (g) => setImmediate(() => void this.onFinish(g).catch((e) => console.error("[game] fin de partie en échec", g.gameId, e))),
      },
    });

    this.rooms.set(gameId, room);
    this.activeByUser.set(o.white.userId, gameId);
    this.activeByUser.set(o.black.userId, gameId);
    this.io.in(userRoom(o.white.userId)).socketsJoin(gameId);
    this.io.in(userRoom(o.black.userId)).socketsJoin(gameId);
    this.io.to(gameId).emit("game:start", {
      gameId, white: room.white, black: room.black, timeControl: tc, stake: o.stake, fen: room.fen,
    });
    this.io.to(gameId).emit("game:state", room.state());

    // Un joueur peut être absent (déconnecté entre l'appariement et la création,
    // ou pas en ligne au moment de son match de tournoi) : la grâce démarre.
    for (const u of [o.white.userId, o.black.userId]) {
      const sockets = await this.io.in(userRoom(u)).fetchSockets();
      if (sockets.length === 0) room.disconnect(u);
    }
    return room;
  }

  /** Dernier socket du joueur fermé. */
  onUserOffline(userId: string): void {
    this.activeGameOf(userId)?.disconnect(userId);
  }

  /** Nouveau socket du joueur : il rejoint sa partie en cours et reçoit l'état complet. */
  onUserOnline(userId: string, socketJoin: (room: string) => void, sendResync: (room: GameRoom) => void): void {
    const room = this.activeGameOf(userId);
    if (!room) return;
    socketJoin(room.id);
    room.reconnect(userId);
    sendResync(room);
  }

  disposeAll(): void {
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
    this.activeByUser.clear();
  }

  private async onFinish(g: FinishedGame): Promise<void> {
    let payouts: Record<string, number> = {};
    let rakeCents = 0;

    // 1. Argent d'abord (idempotent : `settle:<gameId>`).
    if (g.stake.buyInCents > 0) {
      const outcome = g.aborted ? "aborted" : g.result === "1-0" ? "white" : g.result === "0-1" ? "black" : "draw";
      const plan = settleDuel(g.stake.buyInCents, g.white.userId, g.black.userId, outcome, this.cfg.rakeBps);
      await retry("règlement", () => applySettlement(this.ledger, g.gameId, g.stake.currency, plan, { gameId: g.gameId }));
      payouts = plan.payouts;
      rakeCents = plan.rakeCents;
    }

    // 2. Partie + Elo (une transaction, idempotente). Un échec n'empêche pas d'annoncer le résultat.
    let rec: RecordedGame | null = null;
    try {
      rec = await retry("enregistrement", () => this.repo.recordGame(g), 4);
    } catch (e) {
      console.error("[game] partie non enregistrée", g.gameId, e);
    }

    this.audit.append("game.end", {
      gameId: g.gameId, result: g.result, termination: g.termination, pgn: g.pgn, payouts, rakeCents,
      tournamentId: g.tournament?.tournamentId ?? null, ratings: rec?.changes ?? null,
    });
    this.io.to(g.gameId).emit("game:over", {
      gameId: g.gameId, result: g.result, termination: g.termination, pgn: g.pgn, payouts, rakeCents,
      ...(rec?.changes ? {
        ratingChanges: Object.fromEntries(Object.entries(rec.changes).map(([u, c]) => [u, { before: c.before, after: c.after }])),
      } : {}),
    });

    this.activeByUser.delete(g.white.userId);
    this.activeByUser.delete(g.black.userId);
    this.io.in(g.gameId).socketsLeave(g.gameId);
    this.rooms.delete(g.gameId);
    for (const fn of this.onFinishedListeners) {
      try {
        await fn(g, rec);
      } catch (e) {
        console.error("[game] écouteur de fin de partie en erreur", e);
      }
    }

    if (this.submitAnalysis && !g.aborted && g.moveTimesMs.length >= 20) {
      this.submitAnalysis({
        gameId: g.gameId, pgn: g.pgn, timeControl: g.timeControl.id,
        players: { w: g.white, b: g.black }, moveTimesMs: g.moveTimesMs,
        focusLoss: g.focusLoss, currency: g.stake.currency,
      }).catch((e) => console.error("[analysis] envoi échoué", g.gameId, e));
    }
  }
}
