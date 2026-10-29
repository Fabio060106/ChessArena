import type { SngFormat } from "@chessarena/shared";

/**
 * Configuration du game-server. `loadConfig()` lit l'environnement ; les tests
 * construisent la leur avec `{ ...defaultConfig, ...overrides }`.
 */
export interface GameServerConfig {
  port: number;
  corsOrigin: string;
  jwtSecret: string;
  /** DEV uniquement : accepte `auth.userId` sans JWT. Forcé à false si NODE_ENV=production. */
  devAuth: boolean;
  databaseUrl: string;
  analysisUrl: string;
  /** Rake en points de base : 1000 = 10 %. */
  rakeBps: number;
  /** ADR-9 — interrupteur global argent réel. */
  realMoneyEnabled: boolean;
  /** Pays (ISO-3166) où l'argent réel est autorisé. Vide = nulle part. */
  realMoneyCountries: string[];
  /** Délai pour jouer chacun des 2 premiers demi-coups, sinon partie annulée. */
  firstMoveTimeoutMs: number;
  /** Grâce de reconnexion avant défaite par forfait. */
  disconnectGraceMs: number;
  /** Période d'appariement du matchmaker. */
  matchmakerTickMs: number;
  /** Période des sondes de latence serveur → client. */
  lagProbeIntervalMs: number;
  /** Limite d'événements entrants par socket (token bucket). */
  rateLimit: { burst: number; perSecond: number };
  /** Mises PLAY autorisées (centimes de jetons). */
  stakeLimits: { minCents: number; maxCents: number };
  /** Jetons PLAY offerts à la 1re connexion (ledger mémoire uniquement). */
  playFaucetCents: number;
  auditLogPath: string;
  /** Envoi des parties au service d'analyse (désactivé dans les tests). */
  analysisEnabled: boolean;
  /** Applique les migrations SQL au démarrage (dev / staging). */
  migrateOnStart: boolean;
  /** Formats de Sit & Go proposés dans le lobby (une table ouverte par format). */
  tournamentFormats: SngFormat[];
  /** Redis (BullMQ) : file d'analyse + verdicts fair-play. Vide = envoi HTTP au service d'analyse. */
  redisUrl: string;
  queuePrefix: string;
  /** Période d'exécution des retraits (0 = désactivé). */
  withdrawalIntervalMs: number;
  // ─── Conformité (Sprint 4) ───────────────────────────────────────────────────
  /** CIDR des proxys / load balancers dont on accepte X-Forwarded-For et l'en-tête pays. */
  trustedProxies: string[];
  /** Base IP → pays (CSV `network,country_iso_code`). Vide = pays inconnu partout → PLAY_MONEY_ONLY. */
  geoIpCsvPath: string;
  /** En-tête pays posé par l'edge (ex. "cf-ipcountry"), lu seulement depuis un proxy de confiance. */
  edgeCountryHeader: string;
  /** Secret HMAC des webhooks du prestataire KYC. */
  kycWebhookSecret: string;
  /** Clé privée Ed25519 (PEM PKCS#8) de signature des exports réglementaires. */
  exportSigningKeyPem: string;
  /** Limite de requêtes HTTP par IP (token bucket). */
  httpRateLimit: { burst: number; perSecond: number };
}

export const defaultConfig: GameServerConfig = {
  port: 4000,
  corsOrigin: "http://localhost:3000",
  jwtSecret: "",
  devAuth: false,
  databaseUrl: "",
  analysisUrl: "http://localhost:4100",
  rakeBps: 1000,
  realMoneyEnabled: false,
  realMoneyCountries: [],
  firstMoveTimeoutMs: 20_000,
  disconnectGraceMs: 30_000,
  matchmakerTickMs: 1_000,
  lagProbeIntervalMs: 2_000,
  rateLimit: { burst: 20, perSecond: 10 },
  stakeLimits: { minCents: 0, maxCents: 500 },
  playFaucetCents: 10_000,
  auditLogPath: "./var/audit.jsonl",
  analysisEnabled: true,
  migrateOnStart: false,
  redisUrl: "",
  queuePrefix: "arena",
  withdrawalIntervalMs: 60_000,
  trustedProxies: [],
  geoIpCsvPath: "",
  edgeCountryHeader: "",
  kycWebhookSecret: "",
  exportSigningKeyPem: "",
  httpRateLimit: { burst: 30, perSecond: 5 },
  tournamentFormats: [
    { id: "sng4-blitz3-play500", size: 4, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: 500 },
    { id: "sng8-blitz3-play500", size: 8, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: 500 },
    { id: "sng6-rapid5-play200", size: 6, timeControl: "rapid_5_0", currency: "PLAY", buyInCents: 200 },
  ],
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GameServerConfig {
  const isProd = env.NODE_ENV === "production";
  const cfg: GameServerConfig = {
    ...defaultConfig,
    port: Number(env.PORT ?? defaultConfig.port),
    corsOrigin: env.CORS_ORIGIN ?? defaultConfig.corsOrigin,
    jwtSecret: env.JWT_SECRET ?? "",
    devAuth: env.DEV_AUTH === "1" && !isProd,
    databaseUrl: env.DATABASE_URL ?? "",
    analysisUrl: env.ANALYSIS_URL ?? defaultConfig.analysisUrl,
    rakeBps: Number(env.RAKE_BPS ?? defaultConfig.rakeBps),
    realMoneyEnabled: env.REAL_MONEY_ENABLED === "1",
    realMoneyCountries: (env.REAL_MONEY_COUNTRIES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    auditLogPath: env.AUDIT_LOG_PATH ?? defaultConfig.auditLogPath,
    analysisEnabled: env.ANALYSIS_ENABLED !== "0",
    migrateOnStart: env.MIGRATE_ON_START === "1",
    redisUrl: env.REDIS_URL ?? "",
    queuePrefix: env.QUEUE_PREFIX ?? "arena",
    withdrawalIntervalMs: Number(env.WITHDRAWAL_INTERVAL_MS ?? 60_000),
    trustedProxies: (env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    geoIpCsvPath: env.GEOIP_CSV_PATH ?? "",
    edgeCountryHeader: (env.EDGE_COUNTRY_HEADER ?? "").toLowerCase(),
    kycWebhookSecret: env.KYC_WEBHOOK_SECRET ?? "",
    exportSigningKeyPem: (env.EXPORT_SIGNING_KEY ?? "").replace(/\\n/g, "\n"),
  };
  if (!cfg.devAuth && !cfg.jwtSecret) throw new Error("JWT_SECRET requis (ou DEV_AUTH=1 hors production)");
  if (isProd && cfg.jwtSecret.length < 32) throw new Error("JWT_SECRET trop court pour la production (≥ 32 caractères)");
  // L'argent réel exige le grand livre PostgreSQL : limites, KYC et garde-fous n'existent qu'en base.
  if (cfg.realMoneyEnabled && !cfg.databaseUrl) throw new Error("REAL_MONEY_ENABLED=1 exige DATABASE_URL");
  if (isProd && cfg.realMoneyEnabled) {
    if (cfg.kycWebhookSecret.length < 32) throw new Error("KYC_WEBHOOK_SECRET requis (≥ 32 caractères) avec l'argent réel");
    if (!cfg.exportSigningKeyPem) throw new Error("EXPORT_SIGNING_KEY requis avec l'argent réel");
    if (!cfg.geoIpCsvPath && !cfg.edgeCountryHeader) throw new Error("géolocalisation requise : GEOIP_CSV_PATH ou EDGE_COUNTRY_HEADER");
  }
  return cfg;
}
