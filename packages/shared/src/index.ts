/**
 * @chessarena/shared — contrats partagés front / game-server / analysis.
 * Toute modification ici est un changement d'API : versionner (PROTOCOL_VERSION).
 */
export const PROTOCOL_VERSION = 1;

// ─── Cadences ────────────────────────────────────────────────────────────────
export type TimeControlId = "bullet_1_0" | "blitz_3_0" | "blitz_3_2" | "rapid_5_0";

export interface TimeControl {
  id: TimeControlId;
  initialMs: number;
  incrementMs: number;
}

export const TIME_CONTROLS: Record<TimeControlId, TimeControl> = {
  bullet_1_0: { id: "bullet_1_0", initialMs: 60_000, incrementMs: 0 },
  blitz_3_0: { id: "blitz_3_0", initialMs: 180_000, incrementMs: 0 },
  blitz_3_2: { id: "blitz_3_2", initialMs: 180_000, incrementMs: 2_000 },
  rapid_5_0: { id: "rapid_5_0", initialMs: 300_000, incrementMs: 0 },
};

// ─── Argent ──────────────────────────────────────────────────────────────────
/** TOUJOURS des entiers en centimes. Jamais de float pour l'argent. */
export type Cents = number;

/**
 * PLAY = crédits fictifs (bêta, sans valeur). EUR = argent réel (KYC obligatoire).
 * Les deux ne se croisent JAMAIS : wallets, files de matchmaking et tournois séparés.
 */
export type Currency = "PLAY" | "EUR";

export interface Stake {
  currency: Currency;
  buyInCents: Cents;
}

// ─── Résultats ───────────────────────────────────────────────────────────────
export type Color = "w" | "b";
export type GameResult = "1-0" | "0-1" | "1/2-1/2";
export type Termination =
  | "checkmate" | "resignation" | "timeout" | "abandon"
  | "stalemate" | "repetition" | "insufficient_material" | "fifty_moves"
  | "agreement" | "timeout_vs_insufficient_material" | "aborted";

// ─── Protocole WebSocket ─────────────────────────────────────────────────────
export interface QueueJoinPayload {
  timeControl: TimeControlId;
  stake: Stake;
}

export interface MovePayload {
  gameId: string;
  /** UCI : e2e4, e7e8q */
  uci: string;
  /** Numéro de demi-coup attendu (anti-doublon / anti-replay). */
  ply: number;
}

export interface ClientSignalPayload {
  gameId: string;
  kind: "focus_lost" | "focus_regained";
  /** horodatage client, informatif seulement (le serveur horodate). */
  clientTs: number;
}

export interface GameStartEvent {
  gameId: string;
  white: { userId: string; rating: number };
  black: { userId: string; rating: number };
  timeControl: TimeControl;
  stake: Stake;
  fen: string;
}

export interface GameStateEvent {
  gameId: string;
  fen: string;
  lastMoveUci: string | null;
  ply: number;
  whiteMs: number;
  blackMs: number;
  turn: Color;
  /** horodatage serveur, pour que le client extrapole l'horloge localement */
  serverTs: number;
}

export interface GameOverEvent {
  gameId: string;
  result: GameResult;
  termination: Termination;
  pgn: string;
  /** Montants crédités (centimes), après rake. Vide si PLAY ou partie annulée. */
  payouts: Record<string, Cents>;
  rakeCents: Cents;
  /** variations Elo par userId (absent si partie non classée) */
  ratingChanges?: Record<string, { before: number; after: number }>;
}

export interface PresenceEvent {
  gameId: string;
  userId: string;
  connected: boolean;
  /** si déconnecté : ms restantes avant défaite par forfait */
  graceMs: number;
}

/** Codes d'erreur stables : le front les traduit, ne JAMAIS afficher le message brut. */
export type ErrorCode =
  | "UNAUTHORIZED" | "BAD_PAYLOAD" | "RATE_LIMITED"
  | "REAL_MONEY_DISABLED" | "JURISDICTION_BLOCKED" | "KYC_REQUIRED_OR_ACCOUNT_HELD" | "ACCOUNT_SUSPENDED"
  | "BAD_STAKE" | "IN_GAME" | "ALREADY_QUEUED" | "STAKE_LOCK_FAILED"
  | "NO_GAME" | "GAME_OVER" | "NOT_A_PLAYER" | "NOT_YOUR_TURN" | "STALE_PLY" | "BAD_FORMAT"
  | "ILLEGAL_MOVE" | "FLAGGED" | "IN_TOURNAMENT"
  | "SELF_EXCLUDED" | "LIMIT_EXCEEDED" | "LIMITS_REQUIRED" | "PLAY_MONEY_ONLY";

export type MoveAck = { ok: true; ply: number } | { ok: false; code: ErrorCode };

// ─── Tournois Sit & Go ───────────────────────────────────────────────────────
export type SngSize = 4 | 6 | 8;
export type SngStatus = "registering" | "running" | "finished" | "cancelled";
export type SngGameKind = "main" | "rematch" | "armageddon";

/** Format de table proposé dans le lobby (une table ouverte par format, recréée dès qu'elle démarre). */
export interface SngFormat {
  id: string;
  size: SngSize;
  timeControl: TimeControlId;
  currency: Currency;
  buyInCents: Cents;
}

export interface SngGameView {
  gameId: string;
  white: string;
  black: string;
  kind: SngGameKind;
  result: GameResult | null;
  termination: Termination | null;
}

export interface SngMatchView {
  round: number;
  slot: number;
  /** null = place pas encore connue ; p2 null au 1er tour = exempt (bye) */
  p1: string | null;
  p2: string | null;
  winner: string | null;
  status: "pending" | "playing" | "done";
  games: SngGameView[];
}

export interface SngPlayerView {
  userId: string;
  rating: number;
  seed: number | null;
  status: "locking" | "registered" | "unregistered" | "playing" | "eliminated" | "winner" | "refunded";
  eliminatedRound: number | null;
  finalRank: number | null;
  payoutCents: Cents;
}

export interface SngSnapshot {
  id: string;
  formatId: string;
  size: SngSize;
  timeControl: TimeControlId;
  currency: Currency;
  buyInCents: Cents;
  sponsorAddedCents: Cents;
  rakeBps: number;
  payoutBps: number[];
  status: SngStatus;
  players: SngPlayerView[];
  rounds: SngMatchView[][];
  currentRound: number;
  /** cagnotte nette à distribuer (inscriptions − rake + dotation) */
  prizePoolCents: Cents;
  rakeCents: Cents;
  cancelReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type SngAck = { ok: true; snapshot: SngSnapshot } | { ok: false; code: string };

// ─── Conformité (Sprint 4) ───────────────────────────────────────────────────
export type KycStatus = "unverified" | "pending" | "verified" | "rejected";

/**
 * Mode de la session, recalculé à la connexion et à chaque bascule du kill-switch.
 * PLAY_MONEY_ONLY : jetons PLAY uniquement (juridiction non autorisée, argent réel coupé, IP inconnue…).
 * LOCKED : aucun jeu (auto-exclusion) ; consultation du compte et retraits seulement.
 */
export type SessionMode = "REAL_MONEY" | "PLAY_MONEY_ONLY" | "LOCKED";
export type SessionModeReason =
  | "OK" | "REAL_MONEY_DISABLED" | "JURISDICTION_BLOCKED" | "UNKNOWN_LOCATION" | "RESIDENCE_BLOCKED" | "SELF_EXCLUDED";

export interface SessionModeEvent {
  mode: SessionMode;
  reason: SessionModeReason;
}

export type RgLimitKind = "deposit_week" | "stake_week" | "stake_per_entry";

export interface RgLimitView {
  kind: RgLimitKind;
  amountCents: Cents;
  /** hausse demandée, effective à `pendingEffectiveAt` (48 h) */
  pendingAmountCents: Cents | null;
  pendingEffectiveAt: string | null;
  /** consommé sur les 7 derniers jours (dépôts ou mises) ; null pour stake_per_entry */
  usedCents: Cents | null;
}

export interface AccountComplianceView {
  kyc: KycStatus;
  limits: RgLimitView[];
  selfExcludedUntil: string | null;
  selfExclusionPermanent: boolean;
}

export interface ServerToClientEvents {
  "queue:joined": (p: { timeControl: TimeControlId; stake: Stake }) => void;
  "queue:left": () => void;
  "game:start": (p: GameStartEvent) => void;
  "game:state": (p: GameStateEvent) => void;
  "game:over": (p: GameOverEvent) => void;
  "game:presence": (p: PresenceEvent) => void;
  /**
   * Sonde de latence initiée par le SERVEUR (ADR-8). Le RTT est mesuré côté serveur :
   * un client ne peut pas déclarer lui-même un faux lag pour gagner du temps.
   */
  "lag:probe": (serverTs: number, ack: (clientTs: number) => void) => void;
  "sng:update": (p: SngSnapshot) => void;
  "session:mode": (p: SessionModeEvent) => void;
  "sng:lobby": (p: SngSnapshot[]) => void;
  "error": (p: { code: ErrorCode; message: string }) => void;
}

export interface ClientToServerEvents {
  "queue:join": (p: QueueJoinPayload) => void;
  "queue:leave": () => void;
  /** ack optionnel : permet l'UI optimiste avec rollback si le serveur refuse. */
  "game:move": (p: MovePayload, ack?: (r: MoveAck) => void) => void;
  "game:resign": (p: { gameId: string }) => void;
  "game:signal": (p: ClientSignalPayload) => void;
  /** synchro d'horloge pour l'AFFICHAGE (offset client↔serveur), sans effet sur l'arbitrage. */
  "time:ping": (clientTs: number, ack: (serverTs: number) => void) => void;
  "sng:list": (ack: (tables: SngSnapshot[]) => void) => void;
  "sng:register": (p: { formatId: string }, ack: (r: SngAck) => void) => void;
  "sng:unregister": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
}

/** Claims du JWT émis par l'API d'auth (le game-server ne fait que vérifier). */
export interface ArenaJwtClaims {
  sub: string;
  /** Elo par cadence ; 1500 par défaut si absent */
  ratings?: Partial<Record<TimeControlId, number>>;
  country?: string;
  /** "active" | "withdrawal_hold" | "suspended" | "self_excluded" | "closed" */
  state?: AccountState;
  /** true si KYC vérifié (condition nécessaire à l'argent réel) */
  kyc?: boolean;
  /** rôle back-office */
  role?: "player" | "moderator" | "compliance" | "admin";
}

export type AccountState = "active" | "withdrawal_hold" | "suspended" | "self_excluded" | "closed";

export const DEFAULT_RATING = 1500;

// ─── Contrat game-server → analysis (file BullMQ `analysis`) ─────────────────
export const ANALYSIS_QUEUE = "analysis";
export const VERDICT_QUEUE = "fairplay-verdicts";

export interface AnalysisRequest {
  gameId: string;
  pgn: string;
  timeControl: TimeControlId;
  players: { w: { userId: string; rating: number }; b: { userId: string; rating: number } };
  /** temps de réflexion facturé par demi-coup, mesuré côté serveur */
  moveTimesMs: number[];
  /** nb de pertes de focus par couleur, pendant la partie */
  focusLoss: { w: number; b: number };
  currency: Currency;
  /** fin de partie (ISO-8601) : ordre chronologique des parties d'un joueur */
  endedAt?: string;
}

export type ExclusionReason = "opening" | "forced" | "extreme_eval" | "untimed";

/** Détail d'un demi-coup, conservé pour le back-office (courbe d'éval, pertes, temps). */
export interface MoveAnalysis {
  ply: number;               // 0 = 1er coup des Blancs
  color: Color;
  san: string;
  uci: string;
  bestUci: string;
  /** éval AVANT le coup, du point de vue des Blancs (centipions, bornée à ±10 000) */
  evalBeforeWhite: number;
  /** éval APRÈS le coup, point de vue des Blancs */
  evalAfterWhite: number;
  /** mat annoncé avant le coup (point de vue des Blancs), sinon null */
  mateBeforeWhite: number | null;
  /** perte du joueur en centipions (≥ 0, évals bornées à ±1000) */
  cpLoss: number;
  matched: boolean;
  timeMs: number;
  included: boolean;
  excludedBy: ExclusionReason | null;
}

export interface PlayerAnalysis {
  userId: string;
  color: Color;
  rating: number;
  analysedMoves: number;
  acpl: number;
  engineMatchRate: number; // 0..1
  timeMeanMs: number;
  /** variance des temps de réflexion (ms²) sur les coups retenus */
  timeVariance: number;
  /** coefficient de variation (écart-type / moyenne) : indépendant de la cadence */
  timeCv: number;
  focusLoss: number;
}

export interface AnalysisResult {
  gameId: string;
  engine: string;
  depth: number;
  players: PlayerAnalysis[];
  moves: MoveAnalysis[];
  durationMs: number;
}

// ─── Verdicts (analysis → game-server, file `fairplay-verdicts`) ─────────────
export type FairPlayLevel = "watch" | "hold";

export interface VerdictEvent {
  userId: string;
  level: FairPlayLevel;
  score: number;
  reasons: string[];
  gameIds: string[];
  depth: number;
  ruleVersion: string;
  at: string;
}

// ─── Back-office anti-triche (API admin du game-server) ──────────────────────
export type CaseResolution = "clean" | "watch" | "cheat";

export interface CaseSummary {
  id: string;
  userId: string;
  status: "open" | "resolved";
  level: FairPlayLevel;
  score: number;
  reasons: string[];
  accountState: AccountState;
  createdAt: string;
  updatedAt: string;
  resolution: CaseResolution | null;
  gamesCount: number;
  /** retraits en attente (centimes EUR) */
  pendingWithdrawalCents: Cents;
}

export interface CaseGameView {
  gameId: string;
  endedAt: string;
  timeControl: TimeControlId;
  currency: Currency;
  buyInCents: Cents;
  color: Color;
  opponent: string;
  result: GameResult;
  termination: string;
  ratingAtGame: number;
  depth: number;
  engine: string;
  acpl: number;
  engineMatchRate: number;
  analysedMoves: number;
  timeMeanMs: number;
  timeCv: number;
  focusLoss: number;
  isTrigger: boolean;
  moves: MoveAnalysis[];
  pgn: string;
}

export interface CaseDetail extends CaseSummary {
  games: CaseGameView[];
  decisions: Array<{ actor: string; action: string; note: string | null; createdAt: string; details: unknown }>;
}

export interface DecisionRequest {
  decision: CaseResolution;
  note: string;
}

export interface DecisionResult {
  caseId: string;
  decision: CaseResolution;
  refunds: Array<{ gameId: string; userId: string; currency: Currency; amountCents: Cents }>;
  confiscated: Partial<Record<Currency, Cents>>;
  cancelledWithdrawals: number;
  releasedWithdrawals: number;
}

/** Vue PUBLIQUE d'un retrait : identique qu'il soit retenu ou non. */
export interface WithdrawalView {
  id: string;
  amountCents: Cents;
  currency: "EUR";
  status: "processing" | "sent" | "cancelled";
  createdAt: string;
}
