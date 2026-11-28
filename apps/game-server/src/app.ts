import { createServer, type Server as HttpServer } from "node:http";
import { performance } from "node:perf_hooks";
import { Server, type Socket } from "socket.io";
import pg from "pg";
import { OFFICIAL_CREATOR, TIME_CONTROLS, type SngSnapshot, type ChallengeAck, type ClubRef, TEAM_BATTLE_LIMITS, type ChallengeView, type LinkChallengeAck, type LinkChallengeView, type ChatAck, type ClientToServerEvents, type LiveGameView, type RematchAck, type WatchAck, type ErrorCode, type ServerToClientEvents, type SessionModeEvent, type SngAck, type TimeControlId } from "@chessarena/shared";
import type { GameServerConfig } from "./config.js";
import { authenticate, canPlay, type AuthUser } from "./auth.js";
import { parseDrawAction, parseGameRef, parseMove, parseQueueJoin, parseSignal } from "./validation.js";
import { Matchmaker } from "./matchmaking/Matchmaker.js";
import { GameManager, userRoom } from "./game/GameManager.js";
import { InMemoryRelayStore, PgRelayStore, RelayService, type FetchJson, type FetchText, type RelayStore } from "./relay/RelayService.js";
import { parseLccUrl } from "./relay/lcc.js";
import { InMemoryReviewStore, PgReviewStore, reviewStoreKey } from "./relay/ReviewStore.js";
import { encodeLichess, parseLichessUrl } from "./relay/lichess.js";

/** Lien collé par l'organisateur : échiquiers DGT (LiveChessCloud) d'abord, sinon Lichess Broadcast. */
function parseRelaySource(raw: string): { source: "lcc" | "lichess"; id: string; round: number } | null {
  const lcc = parseLccUrl(raw);
  if (lcc) return { source: "lcc", id: lcc.id, round: lcc.round };
  const li = parseLichessUrl(raw);
  return li ? { source: "lichess", id: encodeLichess(li), round: 0 } : null;
}
import { CHALLENGE_TTL_MS, ChallengeService, type Challenge } from "./social/ChallengeService.js";
import { LINK_CODE_RE, OpenChallengeService, type OpenChallenge } from "./social/OpenChallengeService.js";
import { InMemoryLedger, PgLedger, lockStakes, refundOrphanedEscrows, type Ledger } from "./settlement/ledger.js";
import { ChatService } from "./social/ChatService.js";
import { basicSignals, type BasicSignal } from "./fairplay/basicSignals.js";
import { RematchService } from "./social/RematchService.js";
import { randomUUID } from "node:crypto";
import { FileAuditLog, PgAuditLog, type AuditSink } from "./audit/auditLog.js";
import { InMemoryGameRepository, PgGameRepository, type GameRepository } from "./persistence/GameRepository.js";
import { InMemoryTournamentStore, PgTournamentStore, type TournamentStore } from "./tournaments/TournamentStore.js";
import { InMemoryClubStore, PgClubStore, type ClubStore } from "./clubs/ClubStore.js";
import { CustomTournamentError, TournamentManager } from "./tournaments/TournamentManager.js";
import { SngError } from "./tournaments/SitAndGo.js";
import { migrate } from "./db/migrate.js";
import { makeAnalysisClient } from "./anticheat/analysisClient.js";
import { makeAnalysisProducer, redisConnection } from "./anticheat/analysisQueue.js";
import { WithdrawalService, type Psp } from "./settlement/withdrawals.js";
import { FairPlayEnforcer } from "./fairplay/FairPlayEnforcer.js";
import { ModerationService } from "./fairplay/ModerationService.js";
import { handleApi } from "./http/api.js";
import { AccountService, InMemoryAccountStore, PgAccountStore, type AccountStore } from "./auth/accounts.js";
import type { Worker } from "bullmq";
import { TokenBucket } from "./net/rateLimiter.js";
import { LagTracker } from "./net/lagTracker.js";
import { ServerMetrics } from "./net/metrics.js";
import { CidrGeoResolver, CidrSet, decideSessionMode, GeoFilter, KillSwitch, unknownGeoResolver, type GeoResolver, type KillSwitchState } from "./net/geoFilter.js";
import { LimitExceededError, LimitsRequiredError, LimitsService, SelfExcludedError, KycRequiredError } from "./fairplay/limits.js";
import { KycService, type KycProvider } from "./auth/kyc.js";
import { DepositService } from "./settlement/deposits.js";
import { RegulatoryExporter } from "./audit/regulatoryExport.js";
import { fetchLichessExport, ImportService } from "./imports/lichessImport.js";
import { InMemoryBetStore, PgBetStore, type Bet, type BetStore } from "./odds/BetStore.js";
import { BetError, PredictionService } from "./odds/PredictionService.js";
import { defaultEngineCommand, WdlEngine, type Evaluate } from "./odds/wdlEngine.js";
import { monthOf } from "./clubs/season.js";
import type { BetPlaceAck, BetView, OddsView, PredictionPick, PredictionsMine, RelayGameView } from "@chessarena/shared";

/** place gardée dans la file après la perte de connexion */
const QUEUE_GRACE_MS = 20_000;
/** délai du premier coup en tournoi (la partie démarre sans que le joueur ait cliqué) */
const TOURNAMENT_FIRST_MOVE_MS = 45_000;

interface SocketData {
  user: AuthUser;
  /** mode de session courant (géo-filtre + kill-switch + auto-exclusion) */
  mode: SessionModeEvent;
  /** pays de l'IP retenu au handshake (null = inconnu) */
  ipCountry: string | null;
  selfExcluded: boolean;
  bucket: TokenBucket;
  lag: LagTracker;
  /** partie regardée en spectateur (une à la fois par onglet) */
  watching: string | null;
  /** retransmission suivie (une à la fois par onglet) */
  relay?: string | null;
}

export type ArenaIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ArenaSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface GameServerDeps {
  pool?: pg.Pool;
  ledger?: Ledger;
  audit?: AuditSink;
  repo?: GameRepository;
  /** comptes joueurs (tests : stockage en mémoire injecté) */
  accountStore?: AccountStore;
  tournamentStore?: TournamentStore;
  clubStore?: ClubStore;
  psp?: Psp;
  /** résolveur IP → pays (tests) ; sinon chargé depuis cfg.geoIpCsvPath */
  geoResolver?: GeoResolver;
  kycProvider?: KycProvider;
  /** retransmissions : stockage et lecture de la source (tests : faux LiveChessCloud) */
  relayStore?: RelayStore;
  /** pronostics : stockage des paris et moteur (null = pas de cotes) ; par défaut Stockfish en sous-processus */
  betStore?: BetStore;
  oddsEvaluate?: Evaluate | null;
  relayFetch?: FetchJson;
  relayFetchText?: FetchText;
  /** import de parties Lichess (tests : faux téléchargement) */
  importFetch?: (url: string) => Promise<string | null>;
  relayLichess?: string;
  relayPool?: string;
  relayIntervals?: { watched: number; idle: number; finished: number };
}

export interface GameServer {
  http: HttpServer;
  io: ArenaIO;
  games: GameManager;
  matchmaker: Matchmaker;
  tournaments: TournamentManager;
  ledger: Ledger;
  audit: AuditSink;
  repo: GameRepository;
  metrics: ServerMetrics;
  pool: pg.Pool | null;
  withdrawals: WithdrawalService | null;
  moderation: ModerationService | null;
  enforcer: FairPlayEnforcer | null;
  limits: LimitsService | null;
  kyc: KycService | null;
  deposits: DepositService | null;
  killSwitch: KillSwitch;
  geo: GeoFilter;
  exporter: RegulatoryExporter | null;
  /** récupération après crash + écoute ; retourne le port */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

const tournamentRoom = (id: string) => `sng:${id}`;
/** spectateurs d'une partie : ils reçoivent aussi tout ce qui est diffusé dans la room de la partie */
const spectatorRoom = (gameId: string) => `spec:${gameId}`;

/**
 * Fabrique du game-server. Aucun effet de bord à l'import : les tests
 * d'intégration démarrent un serveur réel sur un port éphémère.
 *
 * Avec DATABASE_URL : ledger, parties, Elo, tournois et audit dans PostgreSQL.
 * Sans : implémentations mémoire équivalentes (dev, tests unitaires, test de charge).
 */
export function createGameServer(cfg: GameServerConfig, deps: GameServerDeps = {}): GameServer {
  const metrics = new ServerMetrics();
  const pool = deps.pool ?? (cfg.databaseUrl ? new pg.Pool({ connectionString: cfg.databaseUrl, max: 20 }) : null);
  const ownsPool = !deps.pool && !!pool;
  // erreurs sur connexions inactives (redémarrage PG, réseau) : journalisées, jamais fatales
  if (ownsPool) pool!.on("error", (e) => console.error("[pg] connexion inactive perdue", e.message));

  const audit: AuditSink = deps.audit ?? (pool ? new PgAuditLog(pool) : new FileAuditLog(cfg.auditLogPath));
  // Jeu responsable : plafonds de dépôt / mise et auto-exclusion vérifiés DANS chaque transaction comptable
  const limits = pool ? new LimitsService(pool, audit) : null;
  const ledger: Ledger = deps.ledger ?? (pool ? new PgLedger(pool, { audit, policy: limits!.ledgerPolicy }) : new InMemoryLedger());
  const repo: GameRepository = deps.repo ?? (pool ? new PgGameRepository(pool) : new InMemoryGameRepository());
  const accounts = new AccountService(deps.accountStore ?? (pool ? new PgAccountStore(pool) : new InMemoryAccountStore()), { signupsPerIpHour: cfg.signupsPerIpHour });
  // modération du chat : joueurs privés de chat (chargés au démarrage), signalements sans base
  const chatMuted = new Set<string>();
  const memoryReports: Array<{ reporter: string; reported: string; gameId: string; message: string; at: string }> = [];
  // anti-triche de base (sans base de données : en mémoire, pour les tests et le développement)
  const fairplayMem = {
    signals: [] as Array<BasicSignal & { gameId: string; white: string; black: string; result: string; timeControl: string; at: string; reviewed: boolean }>,
    reports: [] as Array<{ reporter: string; reported: string; gameId: string; reason: string; at: string; reviewed: boolean }>,
  };
  const store: TournamentStore = deps.tournamentStore ?? (pool ? new PgTournamentStore(pool) : new InMemoryTournamentStore());
  const clubs: ClubStore = deps.clubStore ?? (pool ? new PgClubStore(pool) : new InMemoryClubStore(async (u) => {
    const r = await repo.getRatings(u);
    return { blitz: r.blitz_3_0.rating, rapid: r.rapid_5_0.rating, games: Object.values(r).reduce((a, x) => a + x.games, 0) };
  }));

  // ─── Argent réel, fair-play, modération (nécessitent PostgreSQL) ──────────────
  const withdrawals = pool && ledger instanceof PgLedger ? new WithdrawalService(pool, ledger, deps.psp) : null;
  const enforcer = pool ? new FairPlayEnforcer(pool, audit) : null;
  const moderation = pool && withdrawals && ledger instanceof PgLedger
    ? new ModerationService(pool, ledger, withdrawals, audit, {
        onBanned: (userId) => io.in(userRoom(userId)).disconnectSockets(true),
      })
    : null;
  const kyc = pool ? new KycService(pool, deps.kycProvider, audit) : null;
  const deposits = ledger instanceof PgLedger ? new DepositService(ledger) : null;
  const exporter = pool ? new RegulatoryExporter(pool, audit, { signingKeyPem: cfg.exportSigningKeyPem, production: process.env.NODE_ENV === "production" }) : null;

  // ─── Géo-filtre et kill-switch ──────────────────────────────────────────────
  let resolver: GeoResolver = deps.geoResolver ?? unknownGeoResolver;
  const killSwitch = new KillSwitch(pool, audit, { envEnabled: cfg.realMoneyEnabled, envCountries: cfg.realMoneyCountries });
  const geo = new GeoFilter(killSwitch, {
    trustedProxies: new CidrSet(cfg.trustedProxies),
    resolver: { lookup: (ip) => resolver.lookup(ip) },
    edgeCountryHeader: cfg.edgeCountryHeader,
  });
  const redis = cfg.redisUrl ? redisConnection(cfg.redisUrl) : null;
  const analysisProducer = redis && cfg.analysisEnabled ? makeAnalysisProducer(redis, cfg.queuePrefix) : null;
  let verdictWorker: Worker | null = null;
  let withdrawalTimer: ReturnType<typeof setInterval> | null = null;
  let stopOfficial: (() => void) | null = null;

  const http = createServer((req, res) => {
    if (/^\/(admin|wallet|account|kyc|auth)\//.test(req.url ?? "")) {
      void handleApi(req, res, { imports, relays, reviews, parseRelaySource, cfg, moderation, withdrawals, limits, kyc, deposits, killSwitch, geo, exporter, pool, repo, accounts, liveGameOf: (u) => games.activeGameOf(u)?.id ?? null, chatMuted,
        clubs, tournaments: { live: (id) => tournaments.get(id)?.snapshot() ?? null, store, showcase: () => tournaments.showcase(), mine: (u) => tournaments.activeFor(u)[0]?.snapshot() ?? null }, memoryReports,
      fairplayMem, isOnline: (u) => (io.of("/").adapter.rooms.get(userRoom(u))?.size ?? 0) > 0, kickUser: (u) => { for (const sk of io.of("/").sockets.values()) if (sk.data.user?.userId === u) sk.disconnect(true); } });
      return;
    }
    if (req.url === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    // aperçu public d'un club (lien partagé) : nom, description, nombre de membres
    const pubClub = /^\/public\/clubs\/([a-z0-9-]{2,48})$/.exec(req.url ?? "");
    if (pubClub && req.method === "GET") {
      void clubs.get(pubClub[1]!).then((c) => {
        if (!c) return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" })
          .end(JSON.stringify({ name: c.name, description: c.description, memberCount: c.memberCount, createdBy: c.createdBy }));
      }).catch(() => res.writeHead(500).end());
      return;
    }
    // vitrine publique (page d'accueil) : prochain tournoi officiel et activité du moment — aucun nom de joueur
    if (req.url === "/public/showcase" && req.method === "GET") {
      const live = tournaments.showcase();
      const official = (s: SngSnapshot) => s.createdBy === OFFICIAL_CREATOR;
      const next = [...live.running.filter((s) => official(s) && s.system === "arena"), ...live.upcoming.filter(official)][0] ?? null;
      const players = next ? next.players.filter((p) => p.status !== "unregistered" && p.status !== "refunded").length : 0;
      return void res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=30" }).end(JSON.stringify({
        nextOfficial: next ? { id: next.id, name: next.name, system: next.system, timeControl: next.timeControl, status: next.status, startsAt: next.startsAt ?? null, arenaEndsAt: next.arenaEndsAt ?? null, players } : null,
        playing: games.activeGames * 2,
        online: io.engine.clientsCount,
      }));
    }
    // défi par lien : qui défie, à quelle cadence (page /defi/<code> et aperçu du lien partagé)
    const pubLink = /^\/public\/challenges\/([a-z0-9]{8})$/.exec(req.url ?? "");
    if (pubLink && req.method === "GET") {
      const c = links.get(pubLink[1]!);
      if (!c) return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return void res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(linkView(c)));
    }
    // aperçu public d'un tournoi (lien partagé sur WhatsApp, Messenger… : titre, format, heure) — aucun nom de joueur
    const pub = /^\/public\/tournaments\/([0-9a-f-]{36})$/i.exec(req.url ?? "");
    if (pub && req.method === "GET") {
      void (async () => {
        const s = tournaments.get(pub[1]!)?.snapshot() ?? await store.load(pub[1]!).catch(() => null);
        if (!s) return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
        const players = s.players.filter((p) => p.status !== "unregistered" && p.status !== "refunded").length;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" }).end(JSON.stringify({
          name: s.name ?? null, createdBy: s.createdBy ?? null, system: s.system ?? "ko", timeControl: s.timeControl, status: s.status,
          size: s.size, players, startsAt: s.startsAt ?? null, arenaMinutes: s.arenaMinutes ?? null, totalRounds: s.totalRounds ?? null,
        }));
      })().catch(() => res.writeHead(500).end());
      return;
    }
    if (req.url === "/metrics") {
      const body = metrics.snapshot({
        activeGames: games.activeGames,
        sockets: io.engine.clientsCount,
        queues: matchmaker.sizes(),
      });
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    }
    if (req.url === "/metrics/reset" && req.method === "POST") {
      metrics.reset();
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });

  const io: ArenaIO = new Server(http, {
    cors: { origin: cfg.corsOrigin },
    transports: ["websocket"], // pas de long-polling : latence et charge moindres
    pingInterval: 10_000,
    pingTimeout: 5_000,
    maxHttpBufferSize: 16 * 1024, // aucun message légitime ne dépasse quelques centaines d'octets
  });

  const games = new GameManager(
    io, ledger, audit, repo, cfg,
    analysisProducer ? (r) => analysisProducer.submit(r) : cfg.analysisEnabled ? makeAnalysisClient(cfg.analysisUrl) : null,
  );
  const matchmaker = new Matchmaker(
    // setImmediate : un tick qui apparie des centaines de paires ne monopolise pas la
    // boucle d'événements ; les coups des parties en cours s'intercalent.
    (a, b) => setImmediate(() => void (console.info(`[match] ${a.userId} vs ${b.userId} ${a.timeControl}`), games.createFromMatch(a, b)).catch((e) => {
      console.error("[match] création échouée", e);
      // les deux joueurs ne restent pas bloqués sur « Recherche… »
      for (const u of [a.userId, b.userId]) {
        io.to(userRoom(u)).emit("queue:left");
        io.to(userRoom(u)).emit("error", { code: "MATCH_FAILED", message: "Appariement impossible, relance la recherche." });
      }
    })),
    { tickMs: cfg.matchmakerTickMs },
  );
  // nombre de joueurs en attente par file, diffusé à tous (sans les noms) quand il change
  let lastStats = "";
  const statsTimer = setInterval(() => {
    const st = JSON.stringify(matchmaker.sizes());
    if (st !== lastStats) { lastStats = st; io.emit("queue:stats", matchmaker.sizes()); }
  }, 2_000);
  statsTimer.unref?.();
  // un joueur qui perd la connexion (téléphone en veille, changement d'appli) garde sa place quelques secondes
  const queueGrace = new Map<string, ReturnType<typeof setTimeout>>();
  const tournaments = new TournamentManager(cfg.tournamentFormats, {
    ledger, store, audit, rakeBps: cfg.rakeBps,
    startGame: async (r) => {
      const room = await games.createGame({
        gameId: r.gameId, white: r.white, black: r.black, timeControl: r.timeControl,
        stake: { currency: r.currency, buyInCents: 0 }, // l'argent est dans l'escrow du tournoi
        rated: r.rated, tournament: r.tournament,
        // en tournoi, la partie démarre toute seule : on laisse plus de temps pour arriver devant l'échiquier
        firstMoveTimeoutMs: Math.max(cfg.firstMoveTimeoutMs, TOURNAMENT_FIRST_MOVE_MS),
      });
      return room.id;
    },
    emitTournament: (s) => io.to(tournamentRoom(s.id)).emit("sng:update", s),
    emitLobby: (tables) => io.emit("sng:lobby", tables),
    isInGame: (u) => !!games.activeGameOf(u),
  });
  games.onGameFinished((g) => tournaments.onGameFinished(g));

  // ─── Social : chat, spectateurs, revanche ─────────────────────────────────
  const chat = new ChatService();
  // retransmissions DGT / LiveChessCloud : une lecture de la source par tournoi, diffusée à tous les spectateurs
  const relayRoom = (id: string) => `relay:${id}`;
  const reviews = pool ? new PgReviewStore(pool) : new InMemoryReviewStore();
  const imports = new ImportService({
    fetchText: deps.importFetch ?? fetchLichessExport,
    save: (u, g) => repo.saveImportedGames(u, g),
    lichess: deps.relayLichess ?? (process.env.LICHESS_URL || undefined),
  });
  // ─── Pronostics en jetons sur les parties retransmises (cotes Stockfish) ───
  const wdlCmd = deps.oddsEvaluate === undefined && process.env.NODE_ENV !== "test" && process.env.PREDICTIONS !== "0" ? defaultEngineCommand() : null;
  const wdlEngine = wdlCmd ? new WdlEngine(wdlCmd) : null;
  const betStore = deps.betStore ?? (pool ? new PgBetStore(pool) : new InMemoryBetStore());
  const betStoreLeaders = (since: string) => betStore.leaders(since, 10).catch(() => []);
  const betView = (b: Bet): BetView => ({ id: b.id, market: b.market, relayId: b.relayId, pick: b.pick, stakeCents: b.stakeCents, odds: b.odds, ply: b.ply, label: b.label, status: b.status, payoutCents: b.payoutCents, createdAt: b.createdAt, settledAt: b.settledAt });
  const predictions = new PredictionService({
    ledger,
    store: betStore,
    evaluate: deps.oddsEvaluate !== undefined ? deps.oddsEvaluate : wdlEngine?.evaluate ?? null,
    emitOdds: (v) => io.to(relayRoom(v.relayId)).emit("relay:odds", v),
    notify: (u, b) => io.to(userRoom(u)).emit("bet:settled", betView(b)),
  });
  const feedPredictions = (relayId: string, round: number, g: RelayGameView) => {
    void predictions.onGame(relayId, round, g).catch((e) => console.error("[pronostics]", e));
  };

  const relays = new RelayService({
    store: deps.relayStore ?? (pool ? new PgRelayStore(pool) : new InMemoryRelayStore()),
    // LCC_POOL_URL : faux LiveChessCloud pour les essais locaux
    fetchJson: deps.relayFetch, fetchText: deps.relayFetchText, lichess: deps.relayLichess ?? (process.env.LICHESS_URL || undefined), pool: deps.relayPool ?? (process.env.LCC_POOL_URL || undefined), intervals: deps.relayIntervals,
    watchers: (id) => io.of("/").adapter.rooms.get(relayRoom(id))?.size ?? 0,
    onRound: (r) => { io.to(relayRoom(r.id)).emit("relay:round", r); if (r.currentRound) for (const g of r.gameList) feedPredictions(r.id, r.currentRound, g); },
    onGame: (relayId, round, game) => { io.to(relayRoom(relayId)).emit("relay:game", { relayId, round, game }); feedPredictions(relayId, round, game); },
  });
  const rematches = new RematchService();
  // défis directs (amis) : sans réponse en 60 s, le défi expire
  const challenges = new ChallengeService((c) => {
    io.to([userRoom(c.from), userRoom(c.to)]).emit("challenge:update", { id: c.id, status: "expired" });
  });
  const links = new OpenChallengeService();
  const linkView = (c: OpenChallenge): LinkChallengeView => ({ code: c.code, from: c.from, timeControl: c.timeControl, expiresAt: links.expiresAt(c) });
  const challengeView = (c: Challenge): ChallengeView => ({ id: c.id, from: c.from, to: c.to, timeControl: c.timeControl, expiresAt: c.createdAt + CHALLENGE_TTL_MS });
  const spectatorCount = (gameId: string) => io.of("/").adapter.rooms.get(spectatorRoom(gameId))?.size ?? 0;
  const withdrawRematches = (userId: string) => {
    for (const w of rematches.leave(userId)) io.to(w.players.map(userRoom)).emit("rematch", { gameId: w.gameId, offeredBy: null, declined: true, unavailable: true });
  };
  // revanche : un joueur déconnecté plus de 10 s (appli fermée, téléphone en veille) n'est plus disponible
  const rematchGone = new Map<string, ReturnType<typeof setTimeout>>();
  const announceSpectators = (gameId: string) => io.to(gameId).emit("game:spectators", { gameId, count: spectatorCount(gameId) });
  games.onGameFinished(async (g) => {
    if (g.aborted) return;
    const sigs = basicSignals({ ...g, timeControl: g.timeControl.id });
    if (pool) {
      for (const s of sigs) {
        await pool.query(
          `INSERT INTO cheat_signals (game_id, user_id, focus_losses, moves, time_cv, reasons, flagged)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [g.gameId, s.userId, s.focusLosses, s.moves, s.timeCv, s.reasons, s.flagged]);
      }
    } else {
      for (const s of sigs) fairplayMem.signals.push({ ...s, gameId: g.gameId, white: g.white.userId, black: g.black.userId, result: g.result, timeControl: g.timeControl.id, at: new Date().toISOString(), reviewed: false });
      if (fairplayMem.signals.length > 5000) fairplayMem.signals.splice(0, 1000);
    }
  });
  games.onGameFinished((g) => {
    chat.ended(g.gameId);
    if (!g.tournament) {
      rematches.finished(g.gameId, {
        white: g.white.userId, black: g.black.userId, timeControl: g.timeControl.id, stake: g.stake, rated: g.rated,
      });
    }
    for (const sock of io.of("/").sockets.values()) if (sock.data.watching === g.gameId) sock.data.watching = null;
    io.in(spectatorRoom(g.gameId)).socketsLeave(spectatorRoom(g.gameId));
  });
  // Drapeau d'affichage : dernier connu par joueur (profil porté par le JWT).
  const flags = new Map<string, string>();
  games.setProfileLookup((userId) => {
    const flag = flags.get(userId);
    return flag ? { flag } : {};
  });

  // ─── Authentification au handshake ────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const user = authenticate(socket.handshake.auth ?? {}, cfg);
      // Elo de référence = base de données (le JWT n'en porte qu'une copie)
      await repo.ensureUser(user.userId);
      // L'état du compte vient de la BASE, jamais du JWT : un token peut être périmé, et un
      // WITHDRAWAL_HOLD ne doit apparaître dans aucun jeton lisible par le client.
      user.state = await repo.getAccountState(user.userId);
      if (user.state === "suspended") throw new Error("ACCOUNT_SUSPENDED");
      // Compte clôturé : plus de jeu ; le solde reste retirable via l'API HTTP
      if (user.state === "closed") throw new Error("ACCOUNT_SUSPENDED");
      // KYC et résidence : la base fait foi (le JWT peut être antérieur à une revérification)
      let selfExcluded = user.state === "self_excluded";
      if (pool) {
        const r = await pool.query<{ kyc: string; country: string | null }>("SELECT kyc, country FROM users WHERE id = $1", [user.userId]);
        user.kycVerified = r.rows[0]?.kyc === "verified";
        user.country = r.rows[0]?.country ?? "";
        selfExcluded = selfExcluded || (await limits!.isExcluded(user.userId));
      }
      const origin = geo.originOf(socket.handshake.address, socket.handshake.headers);
      socket.data.ipCountry = origin.country;
      socket.data.selfExcluded = selfExcluded;
      socket.data.mode = await geo.modeFor(origin.country, user.country || null, selfExcluded);
      const r = await repo.getRatings(user.userId);
      for (const tc of Object.keys(r) as Array<keyof typeof r>) user.ratings[tc] = r[tc].rating;
      socket.data.user = user;
      socket.data.bucket = new TokenBucket(cfg.rateLimit.burst, cfg.rateLimit.perSecond);
      socket.data.lag = new LagTracker();
      socket.data.watching = null;
      next();
    } catch (e) {
      next(new Error(`UNAUTHORIZED: ${(e as Error).message}`));
    }
  });

  /** Recalcule le mode d'une session ; notifie le client s'il change. */
  const applyMode = (socket: ArenaSocket, ks: KillSwitchState) => {
    const next = decideSessionMode({
      killSwitch: ks, ipCountry: socket.data.ipCountry,
      residenceCountry: socket.data.user.country || null, selfExcluded: socket.data.selfExcluded,
    });
    const prev = socket.data.mode;
    socket.data.mode = next;
    if (prev.mode !== next.mode || prev.reason !== next.reason) socket.emit("session:mode", next);
    return next;
  };
  const refreshMode = async (socket: ArenaSocket) => applyMode(socket, await killSwitch.state());

  /**
   * Pré-contrôle des limites de jeu responsable avant d'entrer en file / de s'inscrire
   * (confort : message clair immédiat). Le contrôle qui FAIT FOI reste celui de la
   * transaction comptable, au moment où la mise est réellement bloquée.
   */
  const limitsPrecheck = async (userId: string, cents: number): Promise<ErrorCode | null> => {
    if (!limits) return null;
    try {
      await limits.precheckStake(userId, cents);
      return null;
    } catch (e) {
      if (e instanceof LimitExceededError) return "LIMIT_EXCEEDED";
      if (e instanceof LimitsRequiredError) return "LIMITS_REQUIRED";
      if (e instanceof SelfExcludedError) return "SELF_EXCLUDED";
      if (e instanceof KycRequiredError) return "KYC_REQUIRED_OR_ACCOUNT_HELD";
      throw e;
    }
  };

  /**
   * KILL-SWITCH : à chaque changement d'état (local ou détecté en base depuis une autre
   * instance), toutes les sessions sont réévaluées et notifiées (`session:mode`) :
   *   • tickets EUR en file retirés pour les sessions qui perdent l'argent réel ;
   *   • si l'argent réel est coupé : Sit & Go EUR en inscription annulés et remboursés ;
   *   • les parties et tournois DÉJÀ commencés vont à leur terme (règlement normal).
   */
  killSwitch.onChange(async (ks) => {
    const lost = new Set<string>();
    for (const s of io.of("/").sockets.values()) {
      if (applyMode(s, ks).mode !== "REAL_MONEY") lost.add(s.data.user.userId);
    }
    const removed = matchmaker.dequeueWhere((t) => t.stake.currency === "EUR" && (!ks.enabled || lost.has(t.userId)));
    for (const t of removed) io.to(userRoom(t.userId)).emit("queue:left");
    const cancelled = ks.enabled ? [] : await tournaments.cancelRegistering("EUR", "kill_switch");
    if (removed.length || cancelled.length) {
      console.warn(`[kill-switch] ${removed.length} ticket(s) EUR retiré(s), ${cancelled.length} Sit & Go EUR annulé(s) et remboursé(s)`);
    }
  });

  const fail = (socket: ArenaSocket, code: ErrorCode, message = code) => socket.emit("error", { code, message });

  /** Enveloppe commune : rate limit + isolation des exceptions (un bug ne tue pas le process). */
  const guard = <A extends unknown[]>(socket: ArenaSocket, fn: (...args: A) => unknown) => (...args: A) => {
    if (!socket.data.bucket.take()) {
      metrics.rateLimited++;
      // un événement avec accusé de réception DOIT recevoir une réponse, sinon le client
      // reste bloqué en attente (coup optimiste jamais confirmé ni annulé)
      const ack = args.at(-1);
      if (typeof ack === "function") (ack as (r: unknown) => void)({ ok: false, code: "RATE_LIMITED" });
      return fail(socket, "RATE_LIMITED");
    }
    const onErr = (e: unknown) => {
      console.error("[ws] handler en erreur", e);
      fail(socket, "BAD_PAYLOAD");
    };
    try {
      const r = fn(...args);
      if (r instanceof Promise) r.catch(onErr);
    } catch (e) {
      onErr(e);
    }
  };

  // ─── Sonde de latence initiée par le serveur ──────────────────────────────
  const probeTimer = setInterval(() => {
    for (const s of io.of("/").sockets.values()) {
      const t0 = performance.now();
      s.timeout(2_000).emit("lag:probe", Date.now(), (err: Error | null) => {
        if (!err) s.data.lag.addRtt(performance.now() - t0);
      });
    }
    broadcastNet();
  }, cfg.lagProbeIntervalMs);
  probeTimer.unref();

  /**
   * Ping affiché dans le HUD : meilleur RTT récent de chaque joueur (tous ses sockets),
   * mesuré par le serveur ; au plus ~2 s de retard.
   */
  function broadcastNet(): void {
    const rooms = games.list();
    if (rooms.length === 0) return;
    const best = new Map<string, number>();
    for (const s of io.of("/").sockets.values()) {
      const rtt = s.data.user ? s.data.lag.rttMs : null;
      if (rtt === null) continue;
      const prev = best.get(s.data.user.userId);
      if (prev === undefined || rtt < prev) best.set(s.data.user.userId, rtt);
    }
    for (const room of rooms) {
      const at = (u: string) => { const v = best.get(u); return v === undefined ? null : Math.round(v); };
      io.to(room.id).emit("game:net", { gameId: room.id, rttMs: { w: at(room.white.userId), b: at(room.black.userId) } });
    }
  }

  const welcomeFaucet = async (userId: string) => {
    if (cfg.playFaucetCents <= 0) return;
    // clé idempotente : une seule dotation de bienvenue par joueur, même sur 1 000 connexions
    if (ledger instanceof InMemoryLedger || ledger instanceof PgLedger) {
      await ledger.faucet(userId, cfg.playFaucetCents, "welcome");
    }
  };

  io.on("connection", (socket) => {
    const user = socket.data.user;
    if (user.flag) flags.set(user.userId, user.flag);
    void socket.join(userRoom(user.userId));
    socket.emit("session:mode", socket.data.mode);
    void welcomeFaucet(user.userId).catch((e) => console.error("[faucet]", e));

    // Reprise de partie après reconnexion (ou 2e onglet).
    games.onUserOnline(
      user.userId,
      (room) => void socket.join(room),
      (room) => {
        socket.emit("game:start", room.startEvent());
        socket.emit("game:state", room.state());
        if (room.drawOffer) socket.emit("game:draw", { gameId: room.id, offeredBy: room.drawOffer });
        socket.emit("chat:history", { gameId: room.id, messages: chat.history(room.id, ["players"]) });
        socket.emit("game:spectators", { gameId: room.id, count: spectatorCount(room.id) });
      },
    );
    const goneT = rematchGone.get(user.userId);
    if (goneT) { clearTimeout(goneT); rematchGone.delete(user.userId); }
    // file d'attente conservée pendant une coupure : on la réaffiche
    const graceT = queueGrace.get(user.userId);
    if (graceT) { clearTimeout(graceT); queueGrace.delete(user.userId); }
    const ticket = matchmaker.ticketOf(user.userId);
    if (ticket) socket.emit("queue:joined", { timeControl: ticket.timeControl, stake: ticket.stake });
    socket.emit("queue:stats", matchmaker.sizes());
    // défis reçus encore ouverts (nouvelle page, autre appareil)
    for (const c of challenges.incomingFor(user.userId)) socket.emit("challenge:incoming", challengeView(c));
    // … et de ses tournois en cours.
    for (const t of tournaments.activeFor(user.userId)) {
      void socket.join(tournamentRoom(t.id));
      socket.emit("sng:update", t.snapshot());
    }

    socket.on("time:ping", (_clientTs, ack) => {
      if (typeof ack === "function") ack(Date.now());
    });

    socket.on("queue:join", guard(socket, async (raw: unknown) => {
      const p = parseQueueJoin(raw);
      if (!p) return fail(socket, "BAD_PAYLOAD");
      if (p.stake.currency === "EUR") await refreshMode(socket);   // kill-switch relu (cache 2 s)
      const gate = canPlay(user, p.stake.currency, socket.data.mode);
      if (!gate.ok) return fail(socket, gate.code);
      const { minCents, maxCents } = cfg.stakeLimits;
      if (p.stake.buyInCents < minCents || p.stake.buyInCents > maxCents) return fail(socket, "BAD_STAKE");
      // refus tracés dans les journaux : « on ne s'est pas trouvés » doit pouvoir s'expliquer
      const refuse = (code: "IN_GAME" | "IN_TOURNAMENT" | "ALREADY_QUEUED") => {
        console.info(`[queue] refus ${code} ${user.userId} ${p.timeControl}`);
        return fail(socket, code);
      };
      if (games.activeGameOf(user.userId)) return refuse("IN_GAME");
      if (tournaments.isBusy(user.userId)) return refuse("IN_TOURNAMENT");
      if (matchmaker.isQueued(user.userId)) return refuse("ALREADY_QUEUED");
      if (p.stake.currency === "EUR") {
        const rg = await limitsPrecheck(user.userId, p.stake.buyInCents);
        if (rg) return fail(socket, rg);
      }
      const rating = (await repo.getRatings(user.userId))[p.timeControl].rating; // Elo à jour
      try {
        matchmaker.enqueue({ userId: user.userId, rating, timeControl: p.timeControl, stake: p.stake });
      } catch {
        return fail(socket, "ALREADY_QUEUED");
      }
      io.to(userRoom(user.userId)).emit("queue:joined", p);
      console.info(`[queue] entrée ${user.userId} ${p.timeControl}|${p.stake.currency}|${p.stake.buyInCents} Elo ${rating}`);
      withdrawRematches(user.userId);
    }));

    socket.on("queue:leave", guard(socket, () => {
      if (matchmaker.dequeue(user.userId)) io.to(userRoom(user.userId)).emit("queue:left");
    }));

    socket.on("game:move", guard(socket, (raw: unknown, ack?: unknown) => {
      const t0 = performance.now();
      const reply = typeof ack === "function" ? (ack as (r: unknown) => void) : null;
      const p = parseMove(raw);
      const room = p ? games.get(p.gameId) : undefined;
      let err: ErrorCode | null;
      if (!p) err = "BAD_PAYLOAD";
      else if (!room) err = "NO_GAME";
      else err = room.play(user.userId, p.uci, p.ply, socket.data.lag.oneWayMs);

      if (err) {
        metrics.movesRejected++;
        reply?.({ ok: false, code: err });
        if (room && !room.isFinished) socket.emit("game:state", room.state()); // resynchronise ce client
        else if (!reply) fail(socket, err);
      } else {
        metrics.movesAccepted++;
        reply?.({ ok: true, ply: room!.ply });
      }
      metrics.moveHandling.record(performance.now() - t0);
    }));

    socket.on("game:draw", guard(socket, (raw: unknown) => {
      const p = parseDrawAction(raw);
      if (!p) return fail(socket, "BAD_PAYLOAD");
      const room = games.get(p.gameId);
      if (!room) return fail(socket, "NO_GAME");
      const err = room.draw(user.userId, p.action);
      if (err && err !== "RATE_LIMITED") fail(socket, err);
    }));

    socket.on("game:resign", guard(socket, (raw: unknown) => {
      const p = parseGameRef(raw);
      if (p) games.get(p.gameId)?.resign(user.userId);
    }));

    socket.on("game:berserk", guard(socket, (raw: unknown) => {
      const p = parseGameRef(raw);
      if (!p) return fail(socket, "BAD_PAYLOAD");
      const room = games.get(p.gameId);
      if (!room) return fail(socket, "NO_GAME");
      const err = room.berserk(user.userId);
      if (err) fail(socket, err);
    }));

    socket.on("game:signal", guard(socket, (raw: unknown) => {
      const p = parseSignal(raw);
      if (p?.kind === "focus_lost") games.get(p.gameId)?.recordFocusLoss(user.userId);
    }));

    // ─── Sit & Go ────────────────────────────────────────────────────────────
    socket.on("sng:list", guard(socket, (ack: unknown) => {
      if (typeof ack === "function") ack(tournaments.lobby());
    }));

    const sngReply = (ack: unknown) => (r: SngAck) => { if (typeof ack === "function") ack(r); };
    const sngError = (e: unknown): SngAck => ({
      ok: false, code: e instanceof SngError ? e.code : (e as Error).message === "UNKNOWN_FORMAT" ? "UNKNOWN_FORMAT" : "INTERNAL",
    });

    socket.on("sng:register", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const formatId = (raw as { formatId?: unknown } | null)?.formatId;
      const format = cfg.tournamentFormats.find((f) => f.id === formatId);
      if (!format) return reply({ ok: false, code: "UNKNOWN_FORMAT" });
      if (format.currency === "EUR") await refreshMode(socket);
      const gate = canPlay(user, format.currency, socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      if (format.currency === "EUR") {
        const rg = await limitsPrecheck(user.userId, format.buyInCents);
        if (rg) return reply({ ok: false, code: rg });
      }
      if (games.activeGameOf(user.userId)) return reply({ ok: false, code: "IN_GAME" });
      if (matchmaker.isQueued(user.userId)) return reply({ ok: false, code: "ALREADY_QUEUED" });
      if (tournaments.isBusy(user.userId)) return reply({ ok: false, code: "IN_TOURNAMENT" });
      const rating = (await repo.getRatings(user.userId))[format.timeControl].rating;
      try {
        // le joueur rejoint la room AVANT l'inscription : il reçoit le démarrage s'il complète la table
        const tid = tournaments.lobby().find((t) => t.formatId === format.id)!.id;
        io.in(userRoom(user.userId)).socketsJoin(tournamentRoom(tid));
        const snapshot = await tournaments.register(format.id, user.userId, rating);
        reply({ ok: true, snapshot });
      } catch (e) {
        reply(sngError(e));
      }
    }));

    /** Contrôles communs avant toute inscription PLAY (création ou lien d'invitation). */
    const canJoinTournament = (): string | null => {
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return gate.code;
      if (games.activeGameOf(user.userId)) return "IN_GAME";
      if (matchmaker.isQueued(user.userId)) return "ALREADY_QUEUED";
      // un tournoi à la fois, même programmé (isBusy laisse libre pour les duels, pas pour un second tournoi)
      if (tournaments.activeFor(user.userId).length > 0) return "IN_TOURNAMENT";
      return null;
    };
    const customError = (e: unknown): SngAck =>
      e instanceof CustomTournamentError ? { ok: false, code: e.code }
        : (e as Error).message === "UNKNOWN_TOURNAMENT" ? { ok: false, code: "UNKNOWN_TOURNAMENT" } : sngError(e);

    socket.on("sng:create", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const p = raw as { size?: unknown; timeControl?: unknown; buyInCents?: unknown; name?: unknown; system?: unknown; rounds?: unknown; startsAt?: unknown; arenaMinutes?: unknown; repeatWeekly?: unknown; clubSlug?: unknown; teamClubs?: unknown; teamLeaders?: unknown; membersOnly?: unknown } | null;
      if (!p || typeof p !== "object" || typeof p.timeControl !== "string" || !(p.timeControl in TIME_CONTROLS)) return reply({ ok: false, code: "BAD_PAYLOAD" });
      const blocked = canJoinTournament();
      if (blocked) return reply({ ok: false, code: blocked });
      const timeControl = p.timeControl as TimeControlId;
      const rating = (await repo.getRatings(user.userId))[timeControl].rating;
      // bataille de clubs (arena) : 2 à 8 clubs existants, le créateur membre de l'un d'eux
      let battle: { leaders: number; teams: ClubRef[]; creatorTeam: string } | null = null;
      if (p.teamClubs !== undefined) {
        const slugs = Array.isArray(p.teamClubs) ? [...new Set(p.teamClubs)] : [];
        const leaders = p.teamLeaders === undefined ? 5 : p.teamLeaders;
        if (p.system !== "arena" || slugs.length < TEAM_BATTLE_LIMITS.minTeams || slugs.length > TEAM_BATTLE_LIMITS.maxTeams || !slugs.every((x) => typeof x === "string")
          || !(TEAM_BATTLE_LIMITS.leaders as readonly unknown[]).includes(leaders)) return reply({ ok: false, code: "BAD_PAYLOAD" });
        const teams: ClubRef[] = [];
        let creatorTeam: string | null = null;
        for (const slug of slugs as string[]) {
          const c = await clubs.get(slug).catch(() => null);
          if (!c) return reply({ ok: false, code: "UNKNOWN_CLUB" });
          teams.push({ slug: c.slug, name: c.name });
          if (!creatorTeam && c.members.some((m) => m.userId === user.userId)) creatorTeam = c.slug;
        }
        if (!creatorTeam) return reply({ ok: false, code: "NOT_CLUB_MEMBER" });
        battle = { leaders: leaders as number, teams, creatorTeam };
      }
      // tournoi de club : réservé aux membres du club
      let club: ClubRef | null = null;
      if (p.clubSlug !== undefined) {
        if (typeof p.clubSlug !== "string" || !(await clubs.isMember(p.clubSlug, user.userId))) return reply({ ok: false, code: "NOT_CLUB_MEMBER" });
        const c = await clubs.get(p.clubSlug);
        if (!c) return reply({ ok: false, code: "NOT_CLUB_MEMBER" });
        club = { slug: c.slug, name: c.name };
      }
      try {
        const snapshot = await tournaments.createCustom(
          {
            size: p.size as number, timeControl, buyInCents: p.buyInCents as number, name: typeof p.name === "string" ? p.name : undefined,
            system: p.system === "swiss" || p.system === "arena" ? p.system : p.system === undefined || p.system === "ko" ? "ko" : ("?" as "ko"),
            arenaMinutes: p.arenaMinutes === undefined ? undefined : (p.arenaMinutes as number),
            repeatWeekly: p.repeatWeekly === undefined ? undefined : (p.repeatWeekly as boolean),
            membersOnly: p.membersOnly === true,
            rounds: p.rounds === undefined ? undefined : (p.rounds as number),
            startsAt: p.startsAt === undefined ? undefined : (p.startsAt as string),
          },
          user.userId, rating, club, battle,
        );
        io.in(userRoom(user.userId)).socketsJoin(tournamentRoom(snapshot.id));
        reply({ ok: true, snapshot });
      } catch (e) {
        reply(customError(e));
      }
    }));

    socket.on("sng:join", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      const t = typeof tid === "string" ? tournaments.get(tid) : undefined;
      if (!t) return reply({ ok: false, code: "UNKNOWN_TOURNAMENT" });
      const snap = t.snapshot();
      if (snap.currency !== "PLAY") return reply({ ok: false, code: "BAD_PAYLOAD" }); // l'argent réel passe par les tables officielles
      const blocked = canJoinTournament();
      if (blocked) return reply({ ok: false, code: blocked });
      const rating = (await repo.getRatings(user.userId))[snap.timeControl].rating;
      // tournoi de club réservé aux membres
      if (snap.club && snap.membersOnly && !(await clubs.isMember(snap.club.slug, user.userId).catch(() => false))) return reply({ ok: false, code: "NOT_CLUB_MEMBER" });
      // bataille de clubs : on défend le premier des clubs engagés dont on est membre
      let team: string | null = null;
      if (snap.teamBattle) {
        for (const t of snap.teamBattle.teams) if (await clubs.isMember(t.slug, user.userId).catch(() => false)) { team = t.slug; break; }
        if (!team) return reply({ ok: false, code: "NOT_CLUB_MEMBER" });
      }
      try {
        io.in(userRoom(user.userId)).socketsJoin(tournamentRoom(snap.id));
        reply({ ok: true, snapshot: await tournaments.registerById(snap.id, user.userId, rating, team) });
      } catch (e) {
        reply(customError(e));
      }
    }));

    socket.on("sng:start", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      if (typeof tid !== "string") return reply({ ok: false, code: "BAD_PAYLOAD" });
      try {
        reply({ ok: true, snapshot: await tournaments.startCustom(tid, user.userId) });
      } catch (e) {
        reply(customError(e));
      }
    }));

    // arena : pause / reprise (plus de nouvel adversaire tant qu'on est en pause)
    socket.on("sng:pause", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const p = raw as { tournamentId?: unknown; paused?: unknown } | null;
      const t = typeof p?.tournamentId === "string" ? tournaments.get(p.tournamentId) : undefined;
      if (!t || typeof p?.paused !== "boolean") return reply({ ok: false, code: "BAD_PAYLOAD" });
      try {
        await t.setPaused(user.userId, p.paused);
        reply({ ok: true, snapshot: t.snapshot() });
      } catch (e) {
        reply(customError(e));
      }
    }));

    socket.on("sng:kick", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const p = raw as { tournamentId?: unknown; userId?: unknown } | null;
      const t = typeof p?.tournamentId === "string" ? tournaments.get(p.tournamentId) : undefined;
      if (!t || typeof p?.userId !== "string") return reply({ ok: false, code: "BAD_PAYLOAD" });
      const snap = t.snapshot();
      // seul l'organisateur, jamais lui-même
      if (snap.createdBy !== user.userId || p.userId === user.userId) return reply({ ok: false, code: "FORBIDDEN" });
      try {
        await t.kick(p.userId);
        io.in(userRoom(p.userId)).socketsLeave(tournamentRoom(t.id));
        io.emit("sng:lobby", tournaments.lobby());
        reply({ ok: true, snapshot: t.snapshot() });
      } catch (e) {
        reply(customError(e));
      }
    }));

    socket.on("sng:withdraw", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      const t = typeof tid === "string" ? tournaments.get(tid) : undefined;
      if (!t) return reply({ ok: false, code: "UNKNOWN_TOURNAMENT" });
      try {
        await t.withdraw(user.userId);
        reply({ ok: true, snapshot: t.snapshot() });
      } catch (e) {
        reply(customError(e));
      }
    }));

    socket.on("sng:chat", guard(socket, (raw: unknown, ack: unknown) => {
      const reply = (r: { ok: true; messages: ReturnType<typeof chat.history> } | { ok: false }) => { if (typeof ack === "function") (ack as (x: typeof r) => void)(r); };
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      if (typeof tid !== "string" || !tournaments.get(tid)) return reply({ ok: false });
      reply({ ok: true, messages: chat.history(`tournament:${tid}`, ["players"]) });
    }));

    // suivre un tournoi sans y jouer (page du tournoi : club, spectateurs)
    socket.on("sng:watch", guard(socket, (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      const t = typeof tid === "string" ? tournaments.get(tid) : undefined;
      if (!t) return reply({ ok: false, code: "UNKNOWN_TOURNAMENT" });
      void socket.join(tournamentRoom(t.id));
      reply({ ok: true, snapshot: t.snapshot() });
    }));
    socket.on("sng:unwatch", guard(socket, (raw: unknown) => {
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      // un joueur du tournoi garde ses mises à jour
      if (typeof tid === "string" && !tournaments.get(tid)?.hasPlayer(user.userId)) void socket.leave(tournamentRoom(tid));
    }));

    socket.on("sng:get", guard(socket, (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      const t = typeof tid === "string" ? tournaments.get(tid) : undefined;
      reply(t ? { ok: true, snapshot: t.snapshot() } : { ok: false, code: "UNKNOWN_TOURNAMENT" });
    }));

    socket.on("sng:unregister", guard(socket, async (raw: unknown, ack: unknown) => {
      const reply = sngReply(ack);
      const tid = (raw as { tournamentId?: unknown } | null)?.tournamentId;
      if (typeof tid !== "string") return reply({ ok: false, code: "BAD_PAYLOAD" });
      try {
        const snapshot = await tournaments.unregister(tid, user.userId);
        io.in(userRoom(user.userId)).socketsLeave(tournamentRoom(tid));
        reply({ ok: true, snapshot });
      } catch (e) {
        reply(sngError(e));
      }
    }));

    // ─── Retransmissions ─────────────────────────────────────────────────────
    socket.on("relay:watch", guard(socket, (raw: unknown, ack?: unknown) => {
      const reply = (r: Parameters<Parameters<ClientToServerEvents["relay:watch"]>[1]>[0]) => { if (typeof ack === "function") (ack as (x: typeof r) => void)(r); };
      const id = (raw as { relayId?: unknown } | null)?.relayId;
      if (typeof id !== "string") return reply({ ok: false, code: "BAD_PAYLOAD" });
      const v = relays.view(id);
      if (!v) return reply({ ok: false, code: "UNKNOWN_RELAY" });
      if (socket.data.relay && socket.data.relay !== id) void socket.leave(relayRoom(socket.data.relay));
      socket.data.relay = id;
      void socket.join(relayRoom(id));
      relays.wake(id);
      socket.emit("chat:history", { gameId: `relay:${id}`, messages: chat.history(`relay:${id}`, ["spectators"]) });
      reply({ ok: true, round: v });
    }));
    // ─── Pronostics ──────────────────────────────────────────────────────────
    socket.on("odds:list", guard(socket, (raw: unknown, ack?: unknown) => {
      const id = (raw as { relayId?: unknown } | null)?.relayId;
      if (typeof ack === "function") (ack as (r: OddsView[]) => void)(typeof id === "string" ? predictions.marketsOf(id) : []);
    }));
    socket.on("bet:place", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (r: BetPlaceAck) => { if (typeof ack === "function") (ack as (x: BetPlaceAck) => void)(r); };
      const p = raw as { relayId?: unknown; round?: unknown; index?: unknown; pick?: unknown; stakeCents?: unknown; version?: unknown } | null;
      if (!p || typeof p.relayId !== "string" || typeof p.round !== "number" || typeof p.index !== "number" || typeof p.pick !== "string"
        || typeof p.stakeCents !== "number" || typeof p.version !== "number") return reply({ ok: false, code: "BAD_PAYLOAD" });
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      try {
        const r = await predictions.place(user.userId, { relayId: p.relayId, round: p.round, index: p.index, pick: p.pick as PredictionPick, stakeCents: p.stakeCents, version: p.version });
        reply({ ok: true, bet: betView(r.bet), balanceCents: r.balanceCents });
      } catch (e) {
        if (e instanceof BetError) return reply({ ok: false, code: e.code });
        console.error("[pronostics] mise", e);
        reply({ ok: false, code: "INTERNAL" });
      }
    }));
    socket.on("bet:mine", guard(socket, async (ack?: unknown) => {
      if (typeof ack !== "function") return;
      const mine = await predictions.mine(user.userId);
      const since = new Date(monthOf(Date.now()).start).toISOString();
      (ack as (r: PredictionsMine) => void)({ bets: mine.bets.map(betView), balanceCents: mine.balanceCents, leaders: await betStoreLeaders(since) });
    }));

    socket.on("relay:roundView", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (r: { ok: true; round: import("@chessarena/shared").RelayRoundView } | { ok: false; code: string }) => { if (typeof ack === "function") (ack as (x: typeof r) => void)(r); };
      const p = raw as { relayId?: unknown; round?: unknown } | null;
      if (!p || typeof p.relayId !== "string" || typeof p.round !== "number") return reply({ ok: false, code: "BAD_PAYLOAD" });
      try {
        const v = await relays.roundView(p.relayId, p.round);
        reply(v ? { ok: true, round: v } : { ok: false, code: "UNKNOWN_ROUND" });
      } catch { reply({ ok: false, code: "SOURCE_UNAVAILABLE" }); }
    }));
    socket.on("relay:review", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (review: unknown) => { if (typeof ack === "function") (ack as (x: { review: unknown }) => void)({ review }); };
      const p = raw as { relayId?: unknown; round?: unknown; index?: unknown; plies?: unknown } | null;
      if (!p || typeof p.relayId !== "string" || typeof p.round !== "number" || typeof p.index !== "number" || typeof p.plies !== "number") return reply(null);
      reply(await reviews.get(reviewStoreKey(p.relayId, p.round, p.index, p.plies)).catch(() => null));
    }));
    socket.on("relay:unwatch", guard(socket, (raw: unknown) => {
      const id = (raw as { relayId?: unknown } | null)?.relayId;
      if (typeof id !== "string" || socket.data.relay !== id) return;
      void socket.leave(relayRoom(id));
      socket.data.relay = null;
    }));

    // ─── Chat ────────────────────────────────────────────────────────────────
    socket.on("chat:send", guard(socket, (raw: unknown, ack?: unknown) => {
      const reply = (r: ChatAck) => { if (typeof ack === "function") (ack as (r: ChatAck) => void)(r); };
      const p = raw as { gameId?: unknown; text?: unknown } | null;
      if (!p || typeof p !== "object" || typeof p.gameId !== "string") return reply({ ok: false, code: "BAD_PAYLOAD" });
      const gameId = p.gameId;
      const room = games.get(gameId);
      let target: { channel: "players" | "spectators"; emit: (m: Parameters<typeof io.emit<"chat:msg">>[1]) => void } | null = null;
      if (room && room.colorOf(user.userId)) {
        target = { channel: "players", emit: (m) => io.to(gameId).emit("chat:msg", m) };
      } else if (room && socket.data.watching === gameId) {
        target = { channel: "spectators", emit: (m) => io.to(spectatorRoom(gameId)).emit("chat:msg", m) };
      } else if (gameId.startsWith("tournament:") && tournaments.get(gameId.slice(11))?.isParticipant(user.userId)) {
        // chat du tournoi : écrit par les participants, lu par tous ceux qui suivent le tournoi
        const tid = gameId.slice(11);
        target = { channel: "players", emit: (m) => io.to(tournamentRoom(tid)).emit("chat:msg", m) };
      } else if (gameId.startsWith("relay:") && socket.data.relay === gameId.slice(6)) {
        // retransmission : un seul canal, entre spectateurs
        target = { channel: "spectators", emit: (m) => io.to(relayRoom(gameId.slice(6))).emit("chat:msg", m) };
      } else {
        // après la partie : les deux joueurs peuvent encore se parler (revanche, « bien joué »)
        const pl = rematches.players(gameId);
        if (pl?.includes(user.userId)) target = { channel: "players", emit: (m) => io.to(pl.map(userRoom)).emit("chat:msg", m) };
      }
      if (!target) return reply({ ok: false, code: "NO_GAME" });
      if (chatMuted.has(user.userId)) return reply({ ok: false, code: "MUTED" });
      const m = chat.post(gameId, target.channel, user.userId, p.text);
      if (typeof m === "string") return reply({ ok: false, code: m });
      target.emit(m);
      reply({ ok: true });
    }));

    socket.on("chat:report", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (ok: boolean) => { if (typeof ack === "function") (ack as (r: { ok: boolean }) => void)({ ok }); };
      const p = raw as { gameId?: unknown; messageId?: unknown } | null;
      if (!p || typeof p.gameId !== "string" || typeof p.messageId !== "number") return reply(false);
      const m = chat.history(p.gameId, ["players", "spectators"]).find((x) => x.id === p.messageId);
      if (!m || m.userId === user.userId) return reply(false);
      const r = { reporter: user.userId, reported: m.userId, gameId: m.gameId, message: m.text };
      if (pool) {
        await pool.query("INSERT INTO chat_reports (reporter_id, reported_id, game_id, message) VALUES ($1,$2,$3,$4)", [r.reporter, r.reported, r.gameId, r.message]);
      } else if (memoryReports.length < 1000) memoryReports.push({ ...r, at: new Date().toISOString() });
      reply(true);
    }));

    // ─── Signalement de triche (par un joueur de la partie, contre son adversaire) ──
    socket.on("cheat:report", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (ok: boolean, code?: string) => { if (typeof ack === "function") (ack as (r: { ok: boolean; code?: string }) => void)({ ok, ...(code ? { code } : {}) }); };
      const p = raw as { gameId?: unknown; reason?: unknown } | null;
      if (!p || typeof p.gameId !== "string" || !/^[0-9a-f-]{36}$/i.test(p.gameId)) return reply(false, "BAD_PAYLOAD");
      const reason = typeof p.reason === "string" ? p.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
      let players: [string, string] | null = null;
      if (pool) {
        const r = await pool.query<{ white_id: string; black_id: string }>("SELECT white_id, black_id FROM games WHERE id = $1", [p.gameId]);
        if (r.rows[0]) players = [r.rows[0].white_id, r.rows[0].black_id];
      } else {
        const s = fairplayMem.signals.find((x) => x.gameId === p.gameId);
        if (s) players = [s.white, s.black];
      }
      if (!players || !players.includes(user.userId)) return reply(false, "NOT_A_PLAYER");
      const reported = players[0] === user.userId ? players[1] : players[0];
      if (pool) {
        await pool.query("INSERT INTO cheat_reports (reporter_id, reported_id, game_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [user.userId, reported, p.gameId, reason]);
      } else if (!fairplayMem.reports.some((x) => x.reporter === user.userId && x.gameId === p.gameId)) {
        fairplayMem.reports.push({ reporter: user.userId, reported, gameId: p.gameId, reason, at: new Date().toISOString(), reviewed: false });
      }
      reply(true);
    }));

    // ─── Spectateurs ─────────────────────────────────────────────────────────
    const stopWatching = () => {
      const g = socket.data.watching;
      if (!g) return;
      socket.data.watching = null;
      void socket.leave(spectatorRoom(g));
      // un joueur de cette partie (autre onglet du même compte) ne doit pas quitter la room de jeu
      if (!games.get(g)?.colorOf(user.userId)) void socket.leave(g);
      announceSpectators(g);
    };

    socket.on("watch:list", guard(socket, (ack: unknown) => {
      if (typeof ack !== "function") return;
      const list: LiveGameView[] = games.list().filter((r) => !r.isFinished).map((r) => ({
        gameId: r.id, white: r.white, black: r.black, timeControl: r.timeControl.id, ply: r.ply,
        tournamentId: r.tournamentId, spectators: spectatorCount(r.id),
      }));
      list.sort((a, b) => b.spectators - a.spectators || (b.white.rating + b.black.rating) - (a.white.rating + a.black.rating));
      (ack as (g: LiveGameView[]) => void)(list.slice(0, 100));
    }));

    socket.on("watch:start", guard(socket, (raw: unknown, ack: unknown) => {
      const reply = (r: WatchAck) => { if (typeof ack === "function") (ack as (r: WatchAck) => void)(r); };
      const p = parseGameRef(raw);
      if (!p) return reply({ ok: false, code: "BAD_PAYLOAD" });
      const room = games.get(p.gameId);
      if (!room || room.isFinished) return reply({ ok: false, code: "NO_GAME" });
      if (room.colorOf(user.userId)) return reply({ ok: false, code: "IS_PLAYER" });
      if (socket.data.watching !== room.id) stopWatching();
      socket.data.watching = room.id;
      void socket.join([room.id, spectatorRoom(room.id)]);
      reply({
        ok: true,
        snapshot: {
          start: { gameId: room.id, white: room.white, black: room.black, timeControl: room.timeControl, stake: room.stake, fen: room.fen },
          state: room.state(), moves: room.sans(), chat: chat.history(room.id, ["players", "spectators"]),
          drawOffer: room.drawOffer, spectators: spectatorCount(room.id), tournamentId: room.tournamentId,
        },
      });
      announceSpectators(room.id);
    }));

    socket.on("watch:stop", guard(socket, () => stopWatching()));

    // ─── Revanche ────────────────────────────────────────────────────────────
    socket.on("rematch", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (r: RematchAck) => { if (typeof ack === "function") (ack as (r: RematchAck) => void)(r); };
      const p = raw as { gameId?: unknown; action?: unknown } | null;
      if (!p || typeof p.gameId !== "string" || (p.action !== "offer" && p.action !== "decline")) return reply({ ok: false, code: "BAD_PAYLOAD" });
      const gameId = p.gameId;
      if (p.action === "decline") {
        const pl = rematches.decline(gameId, user.userId);
        if (pl) io.to(pl.map(userRoom)).emit("rematch", { gameId, offeredBy: null, declined: true });
        return reply({ ok: true, started: false });
      }
      // le joueur ne doit pas déjà être occupé ailleurs
      if (games.activeGameOf(user.userId)) return reply({ ok: false, code: "IN_GAME" });
      if (tournaments.isBusy(user.userId)) return reply({ ok: false, code: "IN_TOURNAMENT" });
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      const d = rematches.offer(gameId, user.userId);
      if (d.kind === "error") return reply({ ok: false, code: d.code });
      if (d.kind === "offered") {
        const pl = rematches.players(gameId)!;
        io.to(pl.map(userRoom)).emit("rematch", { gameId, offeredBy: d.by });
        return reply({ ok: true, started: false });
      }
      // acceptée : l'adversaire est-il encore disponible ?
      const other = d.white === user.userId ? d.black : d.white;
      const busy = games.activeGameOf(other) ? "IN_GAME" : tournaments.isBusy(other) ? "IN_TOURNAMENT" : null;
      const restore = () => rematches.restore(gameId, { white: d.black, black: d.white, timeControl: d.timeControl, stake: d.stake, rated: d.rated });
      if (busy || d.stake.currency !== "PLAY") {
        restore();
        io.to([userRoom(user.userId), userRoom(other)]).emit("rematch", { gameId, offeredBy: null, declined: true });
        return reply({ ok: false, code: busy ?? "PLAY_MONEY_ONLY" });
      }
      for (const u of [d.white, d.black]) { if (matchmaker.dequeue(u)) io.to(userRoom(u)).emit("queue:left"); }
      const newId = randomUUID();
      try {
        if (d.stake.buyInCents > 0) await lockStakes(ledger, newId, d.stake.currency, d.stake.buyInCents, [d.white, d.black]);
      } catch {
        restore();
        io.to([userRoom(d.white), userRoom(d.black)]).emit("error", { code: "STAKE_LOCK_FAILED", message: "Solde insuffisant ou mise refusée" });
        io.to([userRoom(d.white), userRoom(d.black)]).emit("rematch", { gameId, offeredBy: null, declined: true });
        return reply({ ok: false, code: "STAKE_LOCK_FAILED" });
      }
      const [rw, rb] = await Promise.all([repo.getRatings(d.white), repo.getRatings(d.black)]);
      io.to([userRoom(d.white), userRoom(d.black)]).emit("rematch", { gameId, offeredBy: null });
      await games.createGame({
        gameId: newId, timeControl: d.timeControl, stake: d.stake, rated: d.rated,
        white: { userId: d.white, rating: rw[d.timeControl].rating }, black: { userId: d.black, rating: rb[d.timeControl].rating },
      });
      reply({ ok: true, started: true });
    }));

    // ─── Défis directs ───────────────────────────────────────────────────────
    const busyCode = (u: string) => games.activeGameOf(u) ? "IN_GAME" : tournaments.isBusy(u) ? "IN_TOURNAMENT" : null;
    const isOnline = (u: string) => (io.of("/").adapter.rooms.get(userRoom(u))?.size ?? 0) > 0;

    socket.on("challenge:send", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (r: ChallengeAck) => { if (typeof ack === "function") (ack as (r: ChallengeAck) => void)(r); };
      const p = raw as { to?: unknown; timeControl?: unknown } | null;
      if (!p || typeof p.to !== "string" || typeof p.timeControl !== "string" || !(p.timeControl in TIME_CONTROLS)) return reply({ ok: false, code: "BAD_PAYLOAD" });
      const acc = await accounts.find(p.to);
      if (!acc || acc.state === "suspended" || acc.state === "closed") return reply({ ok: false, code: "NOT_FOUND" });
      const to = acc.id;
      if (to === user.userId) return reply({ ok: false, code: "SELF" });
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      const mine = busyCode(user.userId);
      if (mine) return reply({ ok: false, code: mine });
      if (!isOnline(to)) return reply({ ok: false, code: "OFFLINE" });
      if (busyCode(to)) return reply({ ok: false, code: "OPPONENT_BUSY" });
      for (const old of challenges.involving(user.userId).filter((c) => c.from === user.userId)) {
        io.to(userRoom(old.to)).emit("challenge:update", { id: old.id, status: "cancelled" });
      }
      const c = challengeView(challenges.create(user.userId, to, p.timeControl as TimeControlId));
      io.to(userRoom(to)).emit("challenge:incoming", c);
      reply({ ok: true, challenge: c });
    }));

    socket.on("challenge:cancel", guard(socket, (raw: unknown) => {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return;
      const c = challenges.get(id);
      if (!c || c.from !== user.userId || !challenges.remove(id)) return;
      io.to([userRoom(c.from), userRoom(c.to)]).emit("challenge:update", { id, status: "cancelled" });
    }));

    socket.on("challenge:answer", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (r: { ok: boolean; code?: string }) => { if (typeof ack === "function") (ack as (r: { ok: boolean; code?: string }) => void)(r); };
      const p = raw as { id?: unknown; accept?: unknown } | null;
      if (!p || typeof p.id !== "string" || typeof p.accept !== "boolean") return reply({ ok: false, code: "BAD_PAYLOAD" });
      const c = challenges.get(p.id);
      if (!c || c.to !== user.userId) return reply({ ok: false, code: "EXPIRED" });
      const both = [userRoom(c.from), userRoom(c.to)];
      if (!p.accept) {
        if (challenges.remove(c.id)) io.to(both).emit("challenge:update", { id: c.id, status: "declined" });
        return reply({ ok: true });
      }
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      const busy = busyCode(c.to) ?? (busyCode(c.from) ? "OPPONENT_BUSY" : null) ?? (isOnline(c.from) ? null : "OFFLINE");
      if (busy) {
        if (challenges.remove(c.id)) io.to(both).emit("challenge:update", { id: c.id, status: "cancelled", reason: busy });
        return reply({ ok: false, code: busy });
      }
      if (!challenges.remove(c.id)) return reply({ ok: false, code: "EXPIRED" }); // déjà traité (double clic, 2e onglet)
      await startFriendly(c.from, c.to, c.timeControl, c.id);
      reply({ ok: true });
    }));

    /** Partie amicale classée, sans mise (défi accepté, lien de défi) : couleurs au hasard ; les deux pages de jeu la reprennent. */
    async function startFriendly(a: string, b: string, tc: TimeControlId, updateId: string): Promise<void> {
      for (const u of [a, b]) {
        if (matchmaker.dequeue(u)) io.to(userRoom(u)).emit("queue:left");
        withdrawRematches(u);
        // ses autres défis tombent : il est en partie
        for (const o of challenges.involving(u)) if (challenges.remove(o.id)) io.to([userRoom(o.from), userRoom(o.to)]).emit("challenge:update", { id: o.id, status: "cancelled", reason: "IN_GAME" });
        const l = links.of(u);
        if (l) links.remove(l.code);
      }
      const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
      const [rw, rb] = await Promise.all([repo.getRatings(white), repo.getRatings(black)]);
      const gameId = randomUUID();
      io.to([userRoom(a), userRoom(b)]).emit("challenge:update", { id: updateId, status: "accepted", gameId });
      await games.createGame({
        gameId, timeControl: tc, stake: { currency: "PLAY", buyInCents: 0 }, rated: true,
        white: { userId: white, rating: rw[tc].rating }, black: { userId: black, rating: rb[tc].rating },
      });
    }

    // ─── Défis par lien ──────────────────────────────────────────────────────
    socket.on("link:create", guard(socket, (raw: unknown, ack?: unknown) => {
      const reply = (r: LinkChallengeAck) => { if (typeof ack === "function") (ack as (r: LinkChallengeAck) => void)(r); };
      const tc = (raw as { timeControl?: unknown } | null)?.timeControl;
      if (typeof tc !== "string" || !(tc in TIME_CONTROLS)) return reply({ ok: false, code: "BAD_PAYLOAD" });
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      reply({ ok: true, link: linkView(links.create(user.userId, tc as TimeControlId)) });
    }));

    socket.on("link:cancel", guard(socket, () => {
      const c = links.of(user.userId);
      if (c) links.remove(c.code);
    }));

    socket.on("link:accept", guard(socket, async (raw: unknown, ack?: unknown) => {
      const reply = (r: { ok: boolean; code?: string }) => { if (typeof ack === "function") (ack as (r: { ok: boolean; code?: string }) => void)(r); };
      const code = (raw as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !LINK_CODE_RE.test(code)) return reply({ ok: false, code: "BAD_PAYLOAD" });
      const c = links.get(code);
      if (!c) return reply({ ok: false, code: "EXPIRED" });
      if (c.from === user.userId) return reply({ ok: false, code: "SELF" });
      const gate = canPlay(user, "PLAY", socket.data.mode);
      if (!gate.ok) return reply({ ok: false, code: gate.code });
      const busy = busyCode(user.userId) ?? (busyCode(c.from) ? "OPPONENT_BUSY" : null) ?? (isOnline(c.from) ? null : "OFFLINE");
      if (busy) return reply({ ok: false, code: busy }); // le lien reste valable (le créateur reviendra peut-être)
      if (!links.remove(code)) return reply({ ok: false, code: "EXPIRED" }); // un autre a été plus rapide
      await startFriendly(c.from, user.userId, c.timeControl, code);
      reply({ ok: true });
    }));

    socket.on("disconnect", () => {
      stopWatching();
      // Plusieurs onglets possibles : on ne considère le joueur parti qu'au DERNIER socket.
      const remaining = io.of("/").adapter.rooms.get(userRoom(user.userId))?.size ?? 0;
      if (remaining === 0) {
        if (matchmaker.isQueued(user.userId) && !queueGrace.has(user.userId)) {
          queueGrace.set(user.userId, setTimeout(() => { queueGrace.delete(user.userId); matchmaker.dequeue(user.userId); }, QUEUE_GRACE_MS));
        }
        games.onUserOffline(user.userId);
        if (!rematchGone.has(user.userId)) {
          rematchGone.set(user.userId, setTimeout(() => {
            rematchGone.delete(user.userId);
            if ((io.of("/").adapter.rooms.get(userRoom(user.userId))?.size ?? 0) === 0) withdrawRematches(user.userId);
          }, 10_000));
        }
        for (const c of challenges.involving(user.userId)) {
          if (challenges.remove(c.id)) io.to([userRoom(c.from), userRoom(c.to)]).emit("challenge:update", { id: c.id, status: "cancelled", reason: "OFFLINE" });
        }
      }
    });
  });

  /**
   * Récupération après crash (au démarrage, avant d'accepter des connexions) :
   *  1. les tournois restés « registering/running » en base sont annulés ;
   *  2. tout escrow encore ouvert (duel ou tournoi interrompu) est remboursé à
   *     l'identique, par lot idempotent. Aucun jeton n'est perdu ni créé.
   */
  async function recover(): Promise<void> {
    if (pool && cfg.migrateOnStart && cfg.databaseUrl) await migrate(cfg.databaseUrl, undefined, console.log);
    if (pool) {
      for (const r of (await pool.query<{ id: string }>("SELECT id FROM users WHERE chat_muted_at IS NOT NULL")).rows) chatMuted.add(r.id);
    }
    // les tournois de joueurs encore en inscription (souvent programmés à l'avance) survivent à une mise en ligne
    const restored: string[] = [];
    for (const s of await store.loadOpenCustom()) {
      try { if (tournaments.restoreCustom(s)) restored.push(s.id); } catch (e) { console.error(`[recover] reprise du tournoi ${s.id} impossible`, e); }
    }
    // tournois de joueurs EN COURS : repris (parties interrompues rejouées ; arena : temps restant)
    for (const s of await store.loadRunningCustom()) {
      try { if (await tournaments.restoreRunningCustom(s)) restored.push(s.id); } catch (e) { console.error(`[recover] reprise du tournoi en cours ${s.id} impossible : il sera annulé et remboursé`, e); }
    }
    const cancelled = await store.cancelInterrupted("server_restart", restored);
    if (restored.length) console.log(`[recover] ${restored.length} tournoi(s) repris (en inscription ou en cours)`);
    const refunded = await refundOrphanedEscrows(ledger, (acc) => {
      const id = acc.split(":")[1] ?? "";
      return games.hasGame(id) || tournaments.ownsEscrow(acc);
    });
    if (cancelled.length || refunded.length) {
      console.warn(`[recover] ${cancelled.length} tournoi(s) annulé(s), ${refunded.length} escrow(s) remboursé(s)`);
    }
  }

  return {
    http, io, games, matchmaker, tournaments, ledger, audit, repo, metrics, pool, withdrawals, moderation, enforcer,
    limits, kyc, deposits, killSwitch, geo, exporter,
    async listen(port = cfg.port) {
      await recover();
      if (!deps.geoResolver && cfg.geoIpCsvPath) {
        resolver = await CidrGeoResolver.fromFile(cfg.geoIpCsvPath);
        console.log(`[geo] ${(resolver as CidrGeoResolver).size} blocs IP chargés`);
      }
      await killSwitch.state();
      killSwitch.watch();
      await relays.start().catch((e) => console.error("[relay] démarrage", e));
      // Championnat du monde 2026 (Lichess) : ajouté d'office jusqu'à la fin du match, sauf RELAY_SEED=0
      if (process.env.NODE_ENV !== "test" && process.env.RELAY_SEED !== "0" && Date.now() < Date.parse("2026-12-20")) {
        const ref = parseRelaySource("https://lichess.org/broadcast/fide-world-chess-championship-2026/game-2/L3j03TZq");
        if (ref) await relays.seed({ name: "Championnat du monde 2026 — Gukesh vs Sindarov", source: ref.source, lccId: ref.id, round: ref.round })
          .then((r) => r && console.log(`[relay] Championnat du monde ajouté (${r.id})`))
          .catch((e) => console.error("[relay] ajout par défaut", e));
      }
      // tournois officiels (Arena du soir, Grand Suisse du dimanche…), sauf OFFICIAL_TOURNAMENTS=0 et en test
      if (process.env.NODE_ENV !== "test" && process.env.OFFICIAL_TOURNAMENTS !== "0") stopOfficial = tournaments.startOfficial();
      if (enforcer && redis) verdictWorker = enforcer.startWorker(redis, cfg.queuePrefix);
      if (withdrawals && cfg.withdrawalIntervalMs > 0) {
        withdrawalTimer = setInterval(() => void withdrawals.process().catch((e) => console.error("[withdrawals]", e)), cfg.withdrawalIntervalMs);
        withdrawalTimer.unref();
      }
      return new Promise((resolve) => {
        http.listen(port, () => {
          const addr = http.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    async close() {
      clearInterval(probeTimer);
      killSwitch.stop();
      // dernière chance d'enregistrer les parties en attente avant l'arrêt (redéploiement)
      if (games.pendingRecords > 0) await games.flushUnrecorded().catch(() => {});
      if (withdrawalTimer) clearInterval(withdrawalTimer);
      stopOfficial?.();
      wdlEngine?.close();
      await verdictWorker?.close();
      await analysisProducer?.close();
      matchmaker.close();
      relays.close();
      clearInterval(statsTimer);
      for (const t of queueGrace.values()) clearTimeout(t);
      for (const t of rematchGone.values()) clearTimeout(t);
      games.disposeAll();
      metrics.close();
      await new Promise<void>((r) => io.close(() => r()));
      await tournaments.shutdown();
      await audit.close();
      if (ownsPool) await pool!.end();
    },
  };
}
