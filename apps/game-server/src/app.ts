import { createServer, type Server as HttpServer } from "node:http";
import { performance } from "node:perf_hooks";
import { Server, type Socket } from "socket.io";
import pg from "pg";
import type { ClientToServerEvents, ErrorCode, ServerToClientEvents, SessionModeEvent, SngAck } from "@chessarena/shared";
import type { GameServerConfig } from "./config.js";
import { authenticate, canPlay, type AuthUser } from "./auth.js";
import { parseGameRef, parseMove, parseQueueJoin, parseSignal } from "./validation.js";
import { Matchmaker } from "./matchmaking/Matchmaker.js";
import { GameManager, userRoom } from "./game/GameManager.js";
import { InMemoryLedger, PgLedger, refundOrphanedEscrows, type Ledger } from "./settlement/ledger.js";
import { FileAuditLog, PgAuditLog, type AuditSink } from "./audit/auditLog.js";
import { InMemoryGameRepository, PgGameRepository, type GameRepository } from "./persistence/GameRepository.js";
import { InMemoryTournamentStore, PgTournamentStore, type TournamentStore } from "./tournaments/TournamentStore.js";
import { TournamentManager } from "./tournaments/TournamentManager.js";
import { SngError } from "./tournaments/SitAndGo.js";
import { migrate } from "./db/migrate.js";
import { makeAnalysisClient } from "./anticheat/analysisClient.js";
import { makeAnalysisProducer, redisConnection } from "./anticheat/analysisQueue.js";
import { WithdrawalService, type Psp } from "./settlement/withdrawals.js";
import { FairPlayEnforcer } from "./fairplay/FairPlayEnforcer.js";
import { ModerationService } from "./fairplay/ModerationService.js";
import { handleApi } from "./http/api.js";
import type { Worker } from "bullmq";
import { TokenBucket } from "./net/rateLimiter.js";
import { LagTracker } from "./net/lagTracker.js";
import { ServerMetrics } from "./net/metrics.js";
import { CidrGeoResolver, CidrSet, decideSessionMode, GeoFilter, KillSwitch, unknownGeoResolver, type GeoResolver, type KillSwitchState } from "./net/geoFilter.js";
import { LimitExceededError, LimitsRequiredError, LimitsService, SelfExcludedError, KycRequiredError } from "./fairplay/limits.js";
import { KycService, type KycProvider } from "./auth/kyc.js";
import { DepositService } from "./settlement/deposits.js";
import { RegulatoryExporter } from "./audit/regulatoryExport.js";

interface SocketData {
  user: AuthUser;
  /** mode de session courant (géo-filtre + kill-switch + auto-exclusion) */
  mode: SessionModeEvent;
  /** pays de l'IP retenu au handshake (null = inconnu) */
  ipCountry: string | null;
  selfExcluded: boolean;
  bucket: TokenBucket;
  lag: LagTracker;
}

export type ArenaIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ArenaSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface GameServerDeps {
  pool?: pg.Pool;
  ledger?: Ledger;
  audit?: AuditSink;
  repo?: GameRepository;
  tournamentStore?: TournamentStore;
  psp?: Psp;
  /** résolveur IP → pays (tests) ; sinon chargé depuis cfg.geoIpCsvPath */
  geoResolver?: GeoResolver;
  kycProvider?: KycProvider;
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
  const store: TournamentStore = deps.tournamentStore ?? (pool ? new PgTournamentStore(pool) : new InMemoryTournamentStore());

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

  const http = createServer((req, res) => {
    if (/^\/(admin|wallet|account|kyc)\//.test(req.url ?? "")) {
      void handleApi(req, res, { cfg, moderation, withdrawals, limits, kyc, deposits, killSwitch, geo, exporter, pool });
      return;
    }
    if (req.url === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
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
    (a, b) => setImmediate(() => void games.createFromMatch(a, b).catch((e) => console.error("[match] création échouée", e))),
    { tickMs: cfg.matchmakerTickMs },
  );
  const tournaments = new TournamentManager(cfg.tournamentFormats, {
    ledger, store, audit, rakeBps: cfg.rakeBps,
    startGame: async (r) => {
      const room = await games.createGame({
        gameId: r.gameId, white: r.white, black: r.black, timeControl: r.timeControl,
        stake: { currency: r.currency, buyInCents: 0 }, // l'argent est dans l'escrow du tournoi
        rated: r.rated, tournament: r.tournament,
      });
      return room.id;
    },
    emitTournament: (s) => io.to(tournamentRoom(s.id)).emit("sng:update", s),
    emitLobby: (tables) => io.emit("sng:lobby", tables),
  });
  games.onGameFinished((g) => tournaments.onGameFinished(g));

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
  }, cfg.lagProbeIntervalMs);
  probeTimer.unref();

  const welcomeFaucet = async (userId: string) => {
    if (cfg.playFaucetCents <= 0) return;
    // clé idempotente : une seule dotation de bienvenue par joueur, même sur 1 000 connexions
    if (ledger instanceof InMemoryLedger || ledger instanceof PgLedger) {
      await ledger.faucet(userId, cfg.playFaucetCents, "welcome");
    }
  };

  io.on("connection", (socket) => {
    const user = socket.data.user;
    void socket.join(userRoom(user.userId));
    socket.emit("session:mode", socket.data.mode);
    void welcomeFaucet(user.userId).catch((e) => console.error("[faucet]", e));

    // Reprise de partie après reconnexion (ou 2e onglet).
    games.onUserOnline(
      user.userId,
      (room) => void socket.join(room),
      (room) => {
        socket.emit("game:start", {
          gameId: room.id, white: room.white, black: room.black,
          timeControl: room.timeControl, stake: room.stake, fen: room.fen,
        });
        socket.emit("game:state", room.state());
      },
    );
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
      if (games.activeGameOf(user.userId)) return fail(socket, "IN_GAME");
      if (tournaments.isBusy(user.userId)) return fail(socket, "IN_TOURNAMENT");
      if (matchmaker.isQueued(user.userId)) return fail(socket, "ALREADY_QUEUED");
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

    socket.on("game:resign", guard(socket, (raw: unknown) => {
      const p = parseGameRef(raw);
      if (p) games.get(p.gameId)?.resign(user.userId);
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

    socket.on("disconnect", () => {
      // Plusieurs onglets possibles : on ne considère le joueur parti qu'au DERNIER socket.
      const remaining = io.of("/").adapter.rooms.get(userRoom(user.userId))?.size ?? 0;
      if (remaining === 0) {
        matchmaker.dequeue(user.userId);
        games.onUserOffline(user.userId);
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
    const cancelled = await store.cancelInterrupted("server_restart");
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
      if (withdrawalTimer) clearInterval(withdrawalTimer);
      await verdictWorker?.close();
      await analysisProducer?.close();
      matchmaker.close();
      games.disposeAll();
      metrics.close();
      await new Promise<void>((r) => io.close(() => r()));
      await tournaments.shutdown();
      await audit.close();
      if (ownsPool) await pool!.end();
    },
  };
}
