import { randomUUID } from "node:crypto";
import { ARENA_MINUTES, SNG_MAX_SIZE, SNG_MIN_SIZE, SWISS_MAX_ROUNDS, TIME_CONTROLS, type ClubRef, type SngCreatePayload, type SngSystem, type SngFormat, type SngSnapshot } from "@chessarena/shared";
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
  /** le joueur est-il en pleine partie ? (un tournoi programmé attend la fin des parties en cours) */
  isInGame?(userId: string): boolean;
}

/** Garde-fous des tournois créés par les joueurs (bêta : jetons PLAY uniquement). */
export const CUSTOM_LIMITS = {
  /** entrée maximale (centimes de jetons) */
  maxBuyInCents: 5_000,
  /** tournois en inscription simultanés, tous créateurs confondus */
  maxOpen: 30,
  /** un tournoi non complet est annulé (inscrits remboursés) au bout de… */
  expireMs: 3 * 60 * 60_000,
  /** tournoi programmé : de 2 minutes à 14 jours à l'avance */
  minLeadMs: 2 * 60_000,
  maxLeadMs: 14 * 24 * 60 * 60_000,
  /** les inscrits d'un tournoi programmé restent libres (duels, autres parties) jusqu'à… avant le départ */
  freeUntilMs: 5 * 60_000,
  /** à l'heure dite, on attend au plus… que les inscrits finissent leur partie en cours */
  maxWaitMs: 10 * 60_000,
} as const;

/** pause entre deux rondes d'un suisse : le temps de voir son résultat et le classement */
export const SWISS_PAUSE_MS = 10_000;

export class CustomTournamentError extends Error {
  constructor(readonly code: "BAD_PAYLOAD" | "TOO_MANY_OPEN" | "ALREADY_CREATED" | "NOT_CREATOR") { super(code); }
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
  /** Tournois de joueurs vivants : à venir (inscriptions) et en cours (page « Tournois »). */
  showcase(): { upcoming: SngSnapshot[]; running: SngSnapshot[] } {
    const custom = [...this.byId.values()].map((t) => t.snapshot()).filter((s) => s.createdBy);
    const startKey = (s: SngSnapshot) => s.startsAt ?? "9999"; // programmés d'abord, par heure de départ
    return {
      upcoming: custom.filter((s) => s.status === "registering").sort((a, b) => startKey(a).localeCompare(startKey(b)) || b.createdAt.localeCompare(a.createdAt)),
      running: custom.filter((s) => s.status === "running").sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
    };
  }

  lobby(): SngSnapshot[] {
    const custom = [...this.customOpen.values()].map((c) => c.t.snapshot()).reverse();
    return [...custom, ...[...this.open.values()].map((t) => t.snapshot())];
  }

  /**
   * Création d'un tournoi par un joueur. Le créateur est inscrit d'office (s'il ne peut pas
   * payer l'entrée, le tournoi n'est pas créé). Un tournoi en inscription par créateur.
   */
  async createCustom(
    p: SngCreatePayload, creator: string, rating: number, club: ClubRef | null = null,
    battle: { leaders: number; teams: ClubRef[]; creatorTeam: string } | null = null,
  ): Promise<SngSnapshot> {
    if (battle && (p.system !== "arena" || battle.teams.length < 2 || battle.teams.length > 8 || !battle.teams.some((t) => t.slug === battle.creatorTeam))) {
      throw new CustomTournamentError("BAD_PAYLOAD");
    }
    if (!Number.isInteger(p.size) || p.size < SNG_MIN_SIZE || p.size > SNG_MAX_SIZE || !(p.timeControl in TIME_CONTROLS)) {
      throw new CustomTournamentError("BAD_PAYLOAD");
    }
    if (!Number.isSafeInteger(p.buyInCents) || p.buyInCents < 0 || p.buyInCents > CUSTOM_LIMITS.maxBuyInCents) {
      throw new CustomTournamentError("BAD_PAYLOAD");
    }
    const system = p.system ?? "ko";
    if (system !== "ko" && system !== "swiss" && system !== "arena") throw new CustomTournamentError("BAD_PAYLOAD");
    const arenaMinutes = system === "arena" ? p.arenaMinutes ?? 30 : 0;
    if (system === "arena" && !(ARENA_MINUTES as readonly number[]).includes(arenaMinutes)) throw new CustomTournamentError("BAD_PAYLOAD");
    const rounds = p.rounds ?? 0;
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > SWISS_MAX_ROUNDS) throw new CustomTournamentError("BAD_PAYLOAD");
    let startsAt: string | null = null;
    if (p.startsAt !== undefined) {
      const at = typeof p.startsAt === "string" ? Date.parse(p.startsAt) : NaN;
      const lead = at - Date.now();
      if (!Number.isFinite(at) || lead < CUSTOM_LIMITS.minLeadMs - 5_000 || lead > CUSTOM_LIMITS.maxLeadMs) throw new CustomTournamentError("BAD_PAYLOAD");
      startsAt = new Date(at).toISOString();
    }
    if (p.repeatWeekly !== undefined && typeof p.repeatWeekly !== "boolean") throw new CustomTournamentError("BAD_PAYLOAD");
    const repeatWeekly = !!p.repeatWeekly;
    if (repeatWeekly && !startsAt) throw new CustomTournamentError("BAD_PAYLOAD"); // une série a besoin d'une heure
    const name = (p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
    for (const c of this.customOpen.values()) if (c.createdBy === creator) throw new CustomTournamentError("ALREADY_CREATED");
    if (this.customOpen.size >= CUSTOM_LIMITS.maxOpen) throw new CustomTournamentError("TOO_MANY_OPEN");

    const id = randomUUID();
    const t = this.makeTable(
      { id: `custom:${id}`, size: p.size, timeControl: p.timeControl, currency: "PLAY", buyInCents: p.buyInCents },
      (s) => this.onCustomChanged(id, s),
      { id, createdBy: creator, name, system, swissRounds: system === "swiss" ? rounds : 0, startsAt, arenaMinutes, repeatWeekly, club, teamBattle: battle ? { leaders: battle.leaders, teams: battle.teams } : null },
    );
    this.customOpen.set(id, { t, createdBy: creator, expiry: this.scheduleOpen(t, Date.now() + CUSTOM_LIMITS.expireMs) });
    try {
      await t.register(creator, rating, battle?.creatorTeam ?? null);
    } catch (e) {
      clearTimeout(this.customOpen.get(id)?.expiry);
      this.customOpen.delete(id);
      this.byId.delete(id);
      throw e;
    }
    this.deps.emitLobby(this.lobby());
    return t.snapshot();
  }

  /**
   * Fin d'attente d'un tournoi ouvert : à l'heure programmée, départ (s'il y a au moins 3 inscrits, une fois
   * leurs parties en cours terminées) ; sans heure, annulation s'il n'est pas complet au bout de 3 h.
   */
  private scheduleOpen(t: SitAndGo, expireAt: number): ReturnType<typeof setTimeout> {
    const at = t.startsAtMs;
    const fire = async (waitedMs = 0): Promise<void> => {
      if (t.state !== "registering") return;
      if (at === null) { await t.cancel("non complet à temps"); this.deps.emitLobby(this.lobby()); return; }
      const players = t.snapshot().players.filter((p) => p.status === "registered").map((p) => p.userId);
      if (players.length < SNG_MIN_SIZE) { await t.cancel("pas assez d'inscrits à l'heure du départ"); this.deps.emitLobby(this.lobby()); return; }
      if (waitedMs < CUSTOM_LIMITS.maxWaitMs && players.some((u) => this.deps.isInGame?.(u))) {
        const again = setTimeout(() => void fire(waitedMs + 15_000).catch((e) => console.error(`[sng ${t.id}] départ programmé`, e)), 15_000);
        again.unref?.();
        return;
      }
      await t.startNow().catch(async (e) => {
        if ((e as { code?: string }).code === "BUSY") { setTimeout(() => void fire(waitedMs + 1_000), 1_000).unref?.(); return; }
        throw e;
      });
      this.deps.emitLobby(this.lobby());
    };
    // setTimeout est borné à ~24,8 jours : les 14 jours maximum passent
    const timer = setTimeout(() => void fire().catch((e) => console.error(`[sng ${t.id}] fin d'attente`, e)), Math.max(0, (at ?? expireAt) - Date.now()));
    timer.unref?.();
    return timer;
  }

  /**
   * Reprise d'un tournoi créé par un joueur, encore en inscription, après un redémarrage du serveur
   * (mise en ligne d'une nouvelle version) : mêmes réglages, mêmes inscrits, l'escrow est resté en base.
   */
  restoreCustom(s: SngSnapshot): SitAndGo | null {
    if (s.status !== "registering" || !s.createdBy || this.byId.has(s.id)) return null;
    const id = s.id;
    const t = this.makeTable(
      { id: `custom:${id}`, size: s.size, timeControl: s.timeControl, currency: s.currency, buyInCents: s.buyInCents },
      (x) => this.onCustomChanged(id, x),
      { id, createdBy: s.createdBy, name: s.name ?? null, system: s.system ?? "ko", swissRounds: s.swissRounds ?? 0, startsAt: s.startsAt ?? null, createdAt: s.createdAt, arenaMinutes: s.arenaMinutes ?? 0, repeatWeekly: !!s.repeatWeekly, club: s.club ?? null,
        teamBattle: s.teamBattle ? { leaders: s.teamBattle.leaders, teams: s.teamBattle.teams.map((t) => ({ slug: t.slug, name: t.name })) } : null },
    );
    t.restoreRegistrations(s.players.filter((p) => p.status === "registered" || p.status === "locking").map((p) => ({ userId: p.userId, rating: p.rating, team: p.team ?? null })));
    this.customOpen.set(id, { t, createdBy: s.createdBy, expiry: this.scheduleOpen(t, Date.parse(s.createdAt) + CUSTOM_LIMITS.expireMs) });
    return t;
  }

  /** Série hebdomadaire : le même tournoi, 7 jours plus tard (le créateur y est inscrit d'office, comme à la création). */
  private async spawnNextWeek(s: SngSnapshot): Promise<void> {
    let at = Date.parse(s.startsAt!) + 7 * 24 * 3600_000;
    while (at - Date.now() < CUSTOM_LIMITS.minLeadMs) at += 7 * 24 * 3600_000;
    const creator = s.createdBy!;
    const rating = s.players.find((p) => p.userId === creator)?.rating ?? 1500;
    await this.createCustom({
      size: s.size, timeControl: s.timeControl, buyInCents: s.buyInCents, name: s.name ?? undefined, system: s.system ?? "ko",
      ...(s.system === "swiss" && s.swissRounds ? { rounds: s.swissRounds } : {}), ...(s.system === "arena" ? { arenaMinutes: s.arenaMinutes } : {}),
      startsAt: new Date(at).toISOString(), repeatWeekly: true,
    }, creator, rating, s.club ?? null,
      s.teamBattle ? { leaders: s.teamBattle.leaders, teams: s.teamBattle.teams.map((t) => ({ slug: t.slug, name: t.name })), creatorTeam: s.players.find((p) => p.userId === creator)?.team ?? s.teamBattle.teams[0]!.slug } : null);
  }

  /** Le créateur lance son tournoi sans attendre qu'il soit complet. */
  async startCustom(tournamentId: string, userId: string): Promise<SngSnapshot> {
    const c = this.customOpen.get(tournamentId);
    if (!c) throw new Error("UNKNOWN_TOURNAMENT");
    if (c.createdBy !== userId) throw new CustomTournamentError("NOT_CREATOR");
    await c.t.startNow();
    this.deps.emitLobby(this.lobby());
    return c.t.snapshot();
  }

  /** Inscription à un tournoi précis (lien d'invitation ou carte du lobby). */
  async registerById(tournamentId: string, userId: string, rating: number, team: string | null = null): Promise<SngSnapshot> {
    const t = this.byId.get(tournamentId);
    if (!t) throw new Error("UNKNOWN_TOURNAMENT");
    await t.register(userId, rating, team);
    this.deps.emitLobby(this.lobby());
    return t.snapshot();
  }

  /** Tournois (non terminés) où ce joueur est engagé. */
  activeFor(userId: string): SitAndGo[] {
    return [...this.byId.values()].filter((t) => t.hasPlayer(userId));
  }

  /** Engagé dans un tournoi : en jeu, ou inscrit à un tournoi qui part bientôt (un tournoi programmé laisse libre jusqu'à 5 min avant). */
  isBusy(userId: string): boolean {
    const soon = Date.now() + CUSTOM_LIMITS.freeUntilMs;
    return this.activeFor(userId).some((t) => t.state !== "registering" || t.startsAtMs === null || t.startsAtMs <= soon);
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
    extra: { id?: string; createdBy?: string; name?: string | null; system?: SngSystem; swissRounds?: number; startsAt?: string | null; createdAt?: string; arenaMinutes?: number; repeatWeekly?: boolean; club?: ClubRef | null; teamBattle?: { leaders: number; teams: ClubRef[] } | null } = {},
  ): SitAndGo {
    const t: SitAndGo = new SitAndGo(
      {
        id: extra.id ?? randomUUID(), formatId: f.id, size: f.size, timeControl: f.timeControl, currency: f.currency,
        buyInCents: f.buyInCents, rakeBps: this.deps.rakeBps,
        // suisse : podium payé (50/30/20) à partir de 8 places ; KO : vainqueur et finaliste
        payoutBps: extra.system && extra.system !== "ko" && f.size >= 8 ? [5_000, 3_000, 2_000] : SIT_AND_GO_STRUCTURES[f.size as 4 | 6 | 8] ?? [6_500, 3_500],
        createdBy: extra.createdBy ?? null, name: extra.name ?? null,
        system: extra.system ?? "ko", swissRounds: extra.swissRounds ?? 0, startsAt: extra.startsAt ?? null, createdAt: extra.createdAt, arenaMinutes: extra.arenaMinutes ?? 0, repeatWeekly: !!extra.repeatWeekly, club: extra.club ?? null, teamBattle: extra.teamBattle ?? null,
      },
      {
        ledger: this.deps.ledger,
        audit: this.deps.audit,
        startGame: (r) => this.deps.startGame(r),
        persist: (s) => this.deps.store.save(s),
        swissPauseMs: SWISS_PAUSE_MS,
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
      // série hebdomadaire : au départ (ou faute d'inscrits à l'heure), on programme la semaine suivante ;
      // un tournoi annulé par son créateur arrête la série
      if (s.repeatWeekly && s.startsAt && (s.status === "running" || s.cancelReason === "pas assez d'inscrits à l'heure du départ")) {
        void this.spawnNextWeek(s).catch((e) => console.error(`[sng ${id}] série hebdomadaire : tournoi suivant non créé`, e));
      }
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
