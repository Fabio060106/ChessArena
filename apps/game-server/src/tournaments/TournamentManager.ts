import { randomUUID } from "node:crypto";
import type { SngFormat, SngSnapshot } from "@chessarena/shared";
import { SitAndGo, type StartGameRequest } from "./SitAndGo.js";
import type { TournamentStore } from "./TournamentStore.js";
import type { Ledger } from "../settlement/ledger.js";
import { SIT_AND_GO_STRUCTURES } from "../settlement/rake.js";
import type { AuditSink } from "../audit/auditLog.js";
import type { FinishedGame } from "../game/GameRoom.js";

export interface TournamentManagerDeps {
  ledger: Ledger;
  store: TournamentStore;
  audit?: AuditSink;
  rakeBps: number;
  startGame(req: StartGameRequest): Promise<string>;
  /** notifie les participants d'un tournoi */
  emitTournament(snapshot: SngSnapshot): void;
  /** notifie le lobby (tables ouvertes) */
  emitLobby(tables: SngSnapshot[]): void;
}

/**
 * Lobby des Sit & Go : une table ouverte par format, recréée dès qu'elle démarre
 * (comme au poker). Route les fins de partie vers le bon tournoi.
 */
export class TournamentManager {
  private readonly open = new Map<string, SitAndGo>();      // formatId → table en inscription
  private readonly byId = new Map<string, SitAndGo>();      // tous les tournois vivants

  constructor(private readonly formats: SngFormat[], private readonly deps: TournamentManagerDeps) {
    for (const f of formats) this.openTable(f);
  }

  get(id: string): SitAndGo | undefined {
    return this.byId.get(id);
  }

  lobby(): SngSnapshot[] {
    return [...this.open.values()].map((t) => t.snapshot());
  }

  /** Tournois (non terminés) où ce joueur est engagé. */
  activeFor(userId: string): SitAndGo[] {
    return [...this.byId.values()].filter((t) => t.hasPlayer(userId));
  }

  isBusy(userId: string): boolean {
    return this.activeFor(userId).length > 0;
  }

  /** Escrow appartenant à un tournoi vivant (pour la récupération après crash). */
  ownsEscrow(account: string): boolean {
    for (const t of this.byId.values()) if (t.escrowAccount === account) return true;
    return false;
  }

  async register(formatId: string, userId: string, rating: number): Promise<SngSnapshot> {
    const t = this.open.get(formatId);
    if (!t) throw new Error("UNKNOWN_FORMAT");
    await t.register(userId, rating);
    this.deps.emitLobby(this.lobby());
    return t.snapshot();
  }

  async unregister(tournamentId: string, userId: string): Promise<SngSnapshot> {
    const t = this.byId.get(tournamentId);
    if (!t) throw new Error("UNKNOWN_TOURNAMENT");
    await t.unregister(userId);
    this.deps.emitLobby(this.lobby());
    return t.snapshot();
  }

  /**
   * Annule (remboursement intégral, sans rake) les tables encore EN INSCRIPTION d'une devise.
   * Les tournois déjà lancés vont à leur terme : interrompre une partie en cours léserait
   * des joueurs qui ont légitimement commencé. Retourne les ids annulés.
   */
  async cancelRegistering(currency: SngFormat["currency"], reason: string): Promise<string[]> {
    const victims = [...this.open.values()].filter((t) => t.currency === currency && t.state === "registering" && t.registeredCount > 0);
    await Promise.all(victims.map((t) => t.cancel(reason)));
    if (victims.length) this.deps.emitLobby(this.lobby());
    return victims.map((t) => t.id);
  }

  async onGameFinished(g: FinishedGame): Promise<void> {
    if (!g.tournament) return;
    await this.byId.get(g.tournament.tournamentId)?.onGameFinished(g);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.byId.values()].map((t) => t.flush()));
  }

  private openTable(f: SngFormat): SitAndGo {
    const t: SitAndGo = new SitAndGo(
      {
        id: randomUUID(), formatId: f.id, size: f.size, timeControl: f.timeControl, currency: f.currency,
        buyInCents: f.buyInCents, rakeBps: this.deps.rakeBps, payoutBps: SIT_AND_GO_STRUCTURES[f.size],
      },
      {
        ledger: this.deps.ledger,
        audit: this.deps.audit,
        startGame: (r) => this.deps.startGame(r),
        persist: (s) => this.deps.store.save(s),
        emit: (s) => {
          this.deps.emitTournament(s);
          this.onTableChanged(f, t, s);
        },
      },
    );
    this.open.set(f.id, t);
    this.byId.set(t.id, t);
    return t;
  }

  private onTableChanged(f: SngFormat, t: SitAndGo, s: SngSnapshot): void {
    // la table vient de démarrer : on en ouvre une nouvelle pour ce format
    if (s.status !== "registering" && this.open.get(f.id) === t) {
      this.openTable(f);
      this.deps.emitLobby(this.lobby());
    }
    if (s.status === "finished" || s.status === "cancelled") {
      // conservé quelques minutes pour les derniers affichages, puis libéré
      setTimeout(() => this.byId.delete(t.id), 10 * 60_000).unref();
    }
  }
}
