import { randomUUID } from "node:crypto";
import { TIME_CONTROLS, type SngCreatePayload, type SngFormat, type SngSnapshot } from "@chessarena/shared";
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

/** Garde-fous des tournois créés par les joueurs (bêta : jetons PLAY uniquement). */
export const CUSTOM_LIMITS = {
  /** entrée maximale (centimes de jetons) */
  maxBuyInCents: 5_000,
  /** tournois en inscription simultanés, tous créateurs confondus */
  maxOpen: 30,
  /** un tournoi non complet est annulé (inscrits remboursés) au bout de… */
  expireMs: 3 * 60 * 60_000,
} as const;

export class CustomTournamentError extends Error {
  constructor(readonly code: "BAD_PAYLOAD" | "TOO_MANY_OPEN" | "ALREADY_CREATED") { super(code); }
}

/**
 * Lobby des Sit & Go : une table ouverte par format, recréée dès qu'elle démarre
 * (comme au poker). Route les fins de partie vers le bon tournoi.
 */
export class TournamentManager {
  private readonly open = new Map<string, SitAndGo>();      // formatId → table en inscription
  private readonly byId = new Map<string, SitAndGo>();      // tous les tournois vivants
  /** tournois créés par des joueurs, encore en inscription (id → créateur) */
  private readonly customOpen = new Map<string, { t: SitAndGo; createdBy: string; expiry: ReturnType<typeof setTimeout> }>();

  constructor(private readonly formats: SngFormat[], private readonly deps: TournamentManagerDeps) {
    for (const f of formats) this.openTable(f);
  }

  get(id: string): SitAndGo | undefined {
    return this.byId.get(id);
  }

  /** Tables ouvertes : d'abord les tournois créés par des joueurs (les plus récents d'abord), puis les tables permanentes. */
  lobby(): SngSnapshot[] {
    const custom = [...this.customOpen.values()].map((c) => c.t.snapshot()).reverse();
    return [...custom, ...[...this.open.values()].map((t) => t.snapshot())];
  }

  /**
   * Création d'un tournoi par un joueur. Le créateur est inscrit d'office (s'il ne peut pas
   * payer l'entrée, le tournoi n'est pas créé). Un tournoi en inscription par créateur.
   */
  async createCustom(p: SngCreatePayload, creator: string, rating: number): Promise<SngSnapshot> {
    if (![4, 6, 8].includes(p.size) || !(p.timeControl in TIME_CONTROLS)) throw new CustomTournamentError("BAD_PAYLOAD");
    if (!Number.isSafeInteger(p.buyInCents) || p.buyInCents < 0 || p.buyInCents > CUSTOM_LIMITS.maxBuyInCents) {
      throw new CustomTournamentError("BAD_PAYLOAD");
    }
    const name = (p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
    for (const c of this.customOpen.values()) if (c.createdBy === creator) throw new CustomTournamentError("ALREADY_CREATED");
    if (this.customOpen.size >= CUSTOM_LIMITS.maxOpen) throw new CustomTournamentError("TOO_MANY_OPEN");

    const id = randomUUID();
    const t = this.makeTable(
      { id: `custom:${id}`, size: p.size, timeControl: p.timeControl, currency: "PLAY", buyInCents: p.buyInCents },
      (s) => this.onCustomChanged(id, s),
      { id, createdBy: creator, name },
    );
    const expiry = setTimeout(() => {
      if (t.state === "registering") void t.cancel("non complet à temps").then(() => this.deps.emitLobby(this.lobby()));
    }, CUSTOM_LIMITS.expireMs);
    expiry.unref?.();
    this.customOpen.set(id, { t, createdBy: creator, expiry });
    try {
      await t.register(creator, rating);
    } catch (e) {
      clearTimeout(expiry);
      this.customOpen.delete(id);
      this.byId.delete(id);
      throw e;
    }
    this.deps.emitLobby(this.lobby());
    return t.snapshot();
  }

  /** Inscription à un tournoi précis (lien d'invitation ou carte du lobby). */
  async registerById(tournamentId: string, userId: string, rating: number): Promise<SngSnapshot> {
    const t = this.byId.get(tournamentId);
    if (!t) throw new Error("UNKNOWN_TOURNAMENT");
    await t.register(userId, rating);
    this.deps.emitLobby(this.lobby());
    return t.snapshot();
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
    // tournoi de joueur que tout le monde a quitté : annulé (rien à rembourser) et retiré du lobby
    const c = this.customOpen.get(tournamentId);
    if (c && t.registeredCount === 0) await t.cancel("plus aucun inscrit");
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
    const t: SitAndGo = this.makeTable(f, (s) => this.onTableChanged(f, t, s));
    this.open.set(f.id, t);
    return t;
  }

  private makeTable(
    f: SngFormat,
    onChange: (s: SngSnapshot) => void,
    extra: { id?: string; createdBy?: string; name?: string | null } = {},
  ): SitAndGo {
    const t: SitAndGo = new SitAndGo(
      {
        id: extra.id ?? randomUUID(), formatId: f.id, size: f.size, timeControl: f.timeControl, currency: f.currency,
        buyInCents: f.buyInCents, rakeBps: this.deps.rakeBps, payoutBps: SIT_AND_GO_STRUCTURES[f.size],
        createdBy: extra.createdBy ?? null, name: extra.name ?? null,
      },
      {
        ledger: this.deps.ledger,
        audit: this.deps.audit,
        startGame: (r) => this.deps.startGame(r),
        persist: (s) => this.deps.store.save(s),
        emit: (s) => {
          this.deps.emitTournament(s);
          onChange(s);
        },
      },
    );
    this.byId.set(t.id, t);
    return t;
  }

  private onCustomChanged(id: string, s: SngSnapshot): void {
    const c = this.customOpen.get(id);
    if (c && s.status !== "registering") {
      clearTimeout(c.expiry);
      this.customOpen.delete(id);
      this.deps.emitLobby(this.lobby());
    }
    if (s.status === "finished" || s.status === "cancelled") {
      setTimeout(() => this.byId.delete(id), 10 * 60_000).unref();
    }
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
