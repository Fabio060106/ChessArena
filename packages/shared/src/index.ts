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

/** Siège d'un joueur tel que vu par les deux camps. */
export interface SeatView {
  userId: string;
  rating: number;
  /** drapeau d'affichage choisi par le joueur (ISO 3166-1 alpha-2) — jamais la résidence KYC */
  flag?: string;
}

export interface GameStartEvent {
  gameId: string;
  white: SeatView;
  black: SeatView;
  timeControl: TimeControl;
  stake: Stake;
  fen: string;
  /** partie de tournoi : pas de revanche, le tableau décide de la suite */
  tournament?: { tournamentId: string; round: number; kind: "main" | "rematch" | "armageddon"; swiss?: boolean; arena?: boolean } | null;
  /** délai pour jouer son premier coup (ms) */
  firstMoveMs?: number;
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
  /** Arena : camps passés en « berserk » (moitié du temps, sans incrément, +1 point en cas de victoire) */
  berserk?: { w: boolean; b: boolean };
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
  /** partie annulée : camp qui n'a pas joué son premier coup (null = personne en cause) */
  abortedBy?: Color | null;
}

export interface PresenceEvent {
  gameId: string;
  userId: string;
  connected: boolean;
  /** si déconnecté : ms restantes avant défaite par forfait */
  graceMs: number;
}

/**
 * Qualité réseau des deux joueurs, mesurée par le SERVEUR (sonde lag:probe), diffusée
 * à la room de la partie toutes les ~2 s. null = pas encore de mesure.
 */
export interface GameNetEvent {
  gameId: string;
  rttMs: Record<Color, number | null>;
}

/** Proposition de nulle en cours (null = aucune). Diffusée aux deux joueurs. */
export interface DrawOfferEvent {
  gameId: string;
  offeredBy: Color | null;
}

export type DrawAction = "offer" | "accept" | "decline";

/** Codes d'erreur stables : le front les traduit, ne JAMAIS afficher le message brut. */
export type ErrorCode =
  | "UNAUTHORIZED" | "BAD_PAYLOAD" | "RATE_LIMITED"
  | "REAL_MONEY_DISABLED" | "JURISDICTION_BLOCKED" | "KYC_REQUIRED_OR_ACCOUNT_HELD" | "ACCOUNT_SUSPENDED"
  | "BAD_STAKE" | "IN_GAME" | "ALREADY_QUEUED" | "STAKE_LOCK_FAILED"
  | "NO_GAME" | "GAME_OVER" | "NOT_A_PLAYER" | "NOT_YOUR_TURN" | "STALE_PLY" | "BAD_FORMAT"
  | "ILLEGAL_MOVE" | "FLAGGED" | "IN_TOURNAMENT" | "BERSERK_REFUSED"
  | "SELF_EXCLUDED" | "LIMIT_EXCEEDED" | "LIMITS_REQUIRED" | "PLAY_MONEY_ONLY" | "MATCH_FAILED";

export type MoveAck = { ok: true; ply: number } | { ok: false; code: ErrorCode };

// ─── Tournois Sit & Go ───────────────────────────────────────────────────────
/** Nombre de places d'un tournoi : 4, 6 ou 8 pour les tables officielles, 3 à 128 pour un tournoi créé par un joueur. */
export type SngSize = number;
/** à 2, ce n'est pas un tournoi mais un match */
export const SNG_MIN_SIZE = 3;
export const SNG_MAX_SIZE = 128;

/** Organisateur des tournois officiels (programmés par le site). Hors du format des pseudos : aucun joueur ne peut le prendre. */
export const OFFICIAL_CREATOR = "@ChessAurum";
export const isOfficial = (createdBy: string | null | undefined): boolean => createdBy === OFFICIAL_CREATOR;
export type SngStatus = "registering" | "running" | "finished" | "cancelled";
export type SngGameKind = "main" | "rematch" | "armageddon";
/** élimination directe (KO) ou système suisse (tout le monde joue toutes les rondes) */
export type SngSystem = "ko" | "swiss" | "arena";
/** Arena : durées proposées (minutes) */
export const ARENA_MINUTES = [20, 30, 45, 60, 90, 120] as const;
/** rondes d'un suisse : de 1 à 15 */
export const SWISS_MAX_ROUNDS = 15;

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
  /** Arena : berserk de chaque camp et nombre de demi-coups joués (le bonus demande 7 coups chacun) */
  berserk?: { w: boolean; b: boolean };
  plies?: number;
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
  /** suisse : p1 a les Blancs ; résultat de l'échiquier (« bye » = exempt, 1 point) */
  result?: GameResult | "bye" | null;
}

export interface SngPlayerView {
  userId: string;
  rating: number;
  seed: number | null;
  status: "locking" | "registered" | "unregistered" | "playing" | "eliminated" | "winner" | "refunded";
  eliminatedRound: number | null;
  finalRank: number | null;
  payoutCents: Cents;
  /** suisse : points (1 par victoire, ½ par nulle, 1 pour un exempt) et départages */
  points?: number;
  buchholz?: number;
  sonnebornBerger?: number;
  /** bataille de clubs : club défendu (adresse) */
  team?: string;
  /** suisse : retiré (absent ou parti) — plus apparié, garde ses points */
  withdrawn?: boolean;
  /** arena : série en cours (la prochaine victoire vaut double), pause, points marqués partie par partie */
  fire?: boolean;
  paused?: boolean;
  sheet?: number[];
}

export interface SngSnapshot {
  id: string;
  formatId: string;
  /** tournoi créé par un joueur (null/absent = table permanente du lobby) */
  createdBy?: string | null;
  /** nom donné par le créateur */
  name?: string | null;
  size: SngSize;
  timeControl: TimeControlId;
  currency: Currency;
  buyInCents: Cents;
  sponsorAddedCents: Cents;
  rakeBps: number;
  payoutBps: number[];
  /** absent = « ko » */
  system?: SngSystem;
  /** suisse : nombre de rondes prévues (fixé au départ selon les inscrits) */
  totalRounds?: number;
  /** suisse : départ de la prochaine ronde (pause entre les rondes) */
  nextRoundAt?: string;
  /** suisse : rondes choisies par le créateur (0 = selon le nombre d'inscrits) */
  swissRounds?: number;
  /** tournoi programmé : départ automatique à cette heure (ISO) */
  startsAt?: string | null;
  /** tournoi programmé répété chaque semaine (le suivant est créé au départ de celui-ci) */
  repeatWeekly?: boolean;
  /** tournoi d'un club (affiché sur la page du club) */
  club?: ClubRef;
  /** tournoi de club réservé à ses membres */
  membersOnly?: boolean;
  /** bataille de clubs (arena uniquement) : clubs engagés et leurs scores */
  teamBattle?: TeamBattleView;
  /** arena : durée (minutes) et heure de fin (une fois lancé) */
  arenaMinutes?: number;
  arenaEndsAt?: string;
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

/** Club : page publique, membres, classement interne, tournois du club. */
export interface ClubSummary {
  slug: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  /** Elo blitz moyen des membres */
  avgBlitz?: number;
  /** batailles de clubs gagnées */
  battlesWon?: number;
}
export interface ClubMember {
  userId: string;
  role: "owner" | "member";
  joinedAt: string;
  blitz: number;
  rapid: number;
  games: number;
}
export interface ClubPost { id: string; author: string; body: string; createdAt: string }
export interface ClubDetail extends ClubSummary {
  members: ClubMember[];
  /** annonces du fondateur, les plus récentes d'abord (10 au plus) */
  posts: ClubPost[];
}
/** Classement du mois d'un club : points de place cumulés sur ses tournois terminés ce mois-ci. */
export interface ClubSeason {
  /** « 2026-11 » */
  month: string;
  tournaments: number;
  rows: Array<{ userId: string; points: number; played: number; wins: number; podiums: number }>;
}
/** barème : 1er 10, 2e 7, 3e 5, 4e 4, 5e 3, toute autre participation 2 */
export const SEASON_POINTS = [10, 7, 5, 4, 3] as const;
export const SEASON_PARTICIPATION = 2;

export interface ClubsResponse {
  mine: ClubSummary[];
  all: ClubSummary[];
}
/** tournoi rattaché à un club */
export interface ClubRef { slug: string; name: string }
/** Bataille de clubs (arena) : score d'un club = somme des points de ses `leaders` meilleurs joueurs */
export interface TeamBattleView {
  leaders: number;
  teams: Array<ClubRef & { score: number; players: number; top: Array<{ userId: string; points: number }> }>;
}
export const TEAM_BATTLE_LIMITS = { minTeams: 2, maxTeams: 8, leaders: [3, 5, 10] } as const;

/** Carte d'un tournoi pour la page « Tournois » (résumé léger d'un instantané). */
export interface TournamentCard {
  id: string;
  name: string | null;
  createdBy: string | null;
  system: SngSystem;
  timeControl: TimeControlId;
  status: SngStatus;
  size: number;
  players: number;
  buyInCents: Cents;
  currency: Currency;
  /** dotation : entrées des inscrits (moins le rake) + dotation garantie ajoutée par le site */
  prizePoolCents: Cents;
  /** dotation garantie (tournois officiels) */
  addedCents: Cents;
  startsAt: string | null;
  repeatWeekly: boolean;
  club: ClubRef | null;
  /** bataille de clubs : clubs et scores */
  teams: Array<ClubRef & { score: number }> | null;
  arenaMinutes: number | null;
  arenaEndsAt: string | null;
  totalRounds: number | null;
  currentRound: number;
  createdAt: string;
  finishedAt: string | null;
  /** les trois premiers (en cours : classement provisoire ; terminé : podium) */
  leaders: Array<{ userId: string; points: number | null }>;
}

export interface TournamentsPageResponse {
  upcoming: TournamentCard[];
  running: TournamentCard[];
  finished: TournamentCard[];
  /** classement du mois des tournois officiels (même barème que les clubs) */
  officialSeason?: ClubSeason;
}

/** Un tournoi dans l'historique d'un joueur (profil). */
export interface TournamentHistoryItem {
  id: string;
  name: string | null;
  createdBy: string | null;
  system: SngSystem;
  timeControl: TimeControlId;
  status: SngStatus;
  players: number;
  /** rang final du joueur (null si annulé ou en cours) */
  rank: number | null;
  points: number | null;
  payoutCents: Cents;
  currency: Currency;
  createdAt: string;
  finishedAt: string | null;
}

/** Création d'un tournoi par un joueur (bêta : jetons PLAY uniquement). */
export interface SngCreatePayload {
  size: SngSize;
  timeControl: TimeControlId;
  buyInCents: Cents;
  name?: string;
  /** « ko » par défaut */
  system?: SngSystem;
  /** suisse : nombre de rondes souhaité (sinon calculé selon le nombre d'inscrits) */
  rounds?: number;
  /** départ programmé (ISO), de 2 minutes à 14 jours ; sinon départ quand complet ou lancé par le créateur */
  startsAt?: string;
  /** arena : durée en minutes (ARENA_MINUTES) */
  arenaMinutes?: number;
  /** avec startsAt : le même tournoi chaque semaine */
  repeatWeekly?: boolean;
  /** tournoi d'un club dont le créateur est membre (adresse du club) */
  clubSlug?: string;
  /** avec clubSlug : réservé aux membres du club */
  membersOnly?: boolean;
  /** bataille de clubs (arena) : adresses des clubs engagés (2 à 8) et nombre de joueurs qui comptent par club */
  teamClubs?: string[];
  teamLeaders?: number;
}

/** Partie terminée, telle qu'affichée dans l'historique d'un joueur. */
export interface GameHistoryItem {
  gameId: string;
  endedAt: string;
  timeControl: TimeControlId;
  currency: Currency;
  buyInCents: Cents;
  rated: boolean;
  color: Color;
  opponent: string;
  result: GameResult;
  /** du point de vue du joueur */
  outcome: "win" | "loss" | "draw" | "aborted";
  termination: Termination;
  ratingBefore: number | null;
  ratingAfter: number | null;
  opponentRating: number | null;
  tournamentId: string | null;
  /** nombre de demi-coups */
  plies: number;
}

/** Partie utilisée pour construire le répertoire d'ouvertures (PGN complet, vu par le joueur). */
export interface RepertoireGame {
  gameId: string;
  endedAt: string;
  color: Color;
  opponent: string;
  outcome: "win" | "loss" | "draw";
  timeControl: TimeControlId;
  pgn: string;
  /** partie importée d'un autre site (absent : jouée sur le site) */
  source?: "lichess" | "pgn";
}

/** GET /account/imports : parties importées (Lichess) et état du dernier import. */
export interface ImportsResponse {
  count: number;
  /** comptes Lichess importés */
  accounts: string[];
  /** parties par origine (Lichess, fichiers PGN) */
  sources?: { lichess: number; pgn: number };
  status: { state: "idle" | "running" | "done" | "error"; account: string | null; found: number; added: number; error: string | null };
  /** ouvertures les plus jouées dans les parties importées */
  openings: Array<{ name: string; color: Color; games: number; score: number }>;
}

/** GET /account/repertoire : les parties + le document de répertoire enregistré (null au départ). */
export interface RepertoireResponse {
  games: RepertoireGame[];
  data: unknown;
  updatedAt: string | null;
}

export interface GameHistoryDetail extends GameHistoryItem {
  /** joueur du point de vue duquel la partie est décrite (parties consultées par lien partagé) */
  player?: string;
  pgn: string;
  /** temps facturé par demi-coup (ms) */
  moveTimesMs: number[];
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

// ─── Social : chat, spectateurs, revanche, profils, classement ───────────────
/** Chat d'une partie : les joueurs entre eux (lu aussi par les spectateurs) ; les spectateurs entre eux (jamais lu par les joueurs). */
export type ChatChannel = "players" | "spectators";
export const CHAT_MAX_LENGTH = 200;

export interface ChatMessage {
  id: number;
  gameId: string;
  channel: ChatChannel;
  userId: string;
  text: string;
  /** horodatage serveur (ms) */
  at: number;
}

export type ChatAck = { ok: true } | { ok: false; code: "RATE_LIMITED" | "BAD_PAYLOAD" | "NO_GAME" | "TOO_LONG" | "EMPTY" | "MUTED" };

/** Partie en cours, telle que listée pour les spectateurs. */
export interface LiveGameView {
  gameId: string;
  white: SeatView;
  black: SeatView;
  timeControl: TimeControlId;
  ply: number;
  tournamentId: string | null;
  spectators: number;
}

/** Ce que reçoit un spectateur en arrivant sur une partie. */
export interface WatchSnapshot {
  start: GameStartEvent;
  state: GameStateEvent;
  /** coups joués (SAN) depuis le début */
  moves: string[];
  chat: ChatMessage[];
  drawOffer: Color | null;
  spectators: number;
  tournamentId: string | null;
}

export type WatchAck = { ok: true; snapshot: WatchSnapshot } | { ok: false; code: "NO_GAME" | "IS_PLAYER" | "BAD_PAYLOAD" };

/** Revanche après une partie hors tournoi : `offeredBy` = qui la propose (null = plus de proposition). */
export interface RematchEvent {
  gameId: string;
  offeredBy: string | null;
  /** la proposition a été refusée (ou n'est plus possible) */
  declined?: boolean;
  /** l'adversaire est parti (déconnecté, autre partie, file d'attente) : plus de revanche possible */
  unavailable?: boolean;
}

export type RematchAck = { ok: true; started: boolean } | { ok: false; code: string };

export interface PlayerProfile {
  userId: string;
  flag: string | null;
  memberSince: string | null;
  ratings: Record<TimeControlId, { rating: number; games: number; peak: number }>;
  totals: { games: number; wins: number; draws: number; losses: number };
  /** dernières parties, du point de vue de ce joueur */
  recent: GameHistoryItem[];
  /** partie en cours (pour la regarder), sinon null */
  liveGameId: string | null;
  /** évolution de l'Elo par cadence (200 dernières parties classées max., de la plus ancienne à la plus récente) ; le premier point est l'Elo avant la première de ces parties */
  ratingHistory?: Partial<Record<TimeControlId, RatingPoint[]>>;
}

/** Un point de la courbe d'Elo : Elo après la partie, date de fin. */
export interface RatingPoint { at: string; rating: number }

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  flag: string | null;
  rating: number;
  games: number;
  peak: number;
}

export interface LeaderboardResponse {
  timeControl: TimeControlId;
  entries: LeaderboardEntry[];
  /** place du joueur connecté (null s'il n'a pas encore joué dans cette cadence) */
  me: LeaderboardEntry | null;
}

/** Ami (liste personnelle) avec sa présence. */
export interface FriendView {
  userId: string;
  flag: string | null;
  /** Elo en blitz 3+0 (repère) */
  rating: number;
  online: boolean;
  /** partie en cours (à regarder), sinon null */
  liveGameId: string | null;
}

export interface ChallengeView {
  id: string;
  from: string;
  to: string;
  timeControl: TimeControlId;
  /** expiration (ms depuis epoch) */
  expiresAt: number;
}

/** Suivi d'un défi envoyé : accepté (avec la partie), refusé, expiré, annulé. */
export interface ChallengeUpdate {
  id: string;
  status: "accepted" | "declined" | "expired" | "cancelled";
  gameId?: string;
  /** pour un défi impossible au moment d'accepter */
  reason?: string;
}

export type ChallengeAck = { ok: true; challenge: ChallengeView } | { ok: false; code: string };

/** Défi par lien (« Joue contre moi ») : public, sans le nom de celui qui l'ouvre. */
export interface LinkChallengeView { code: string; from: string; timeControl: TimeControlId; expiresAt: number }
export type LinkChallengeAck = { ok: true; link: LinkChallengeView } | { ok: false; code: string };

/** Retransmission d'un tournoi officiel (échiquiers électroniques DGT / LiveChessCloud). */
export interface RelayPlayer {
  name: string;
  title: string | null;
  fideId: number | null;
}

export interface RelayGameView {
  /** numéro de la partie dans la ronde (1, 2…) */
  index: number;
  white: RelayPlayer;
  black: RelayPlayer;
  /** « 1-0 », « 0-1 », « 1/2-1/2 », ou null tant que la partie est en cours / pas commencée */
  result: string | null;
  /** partie en cours (pendule qui tourne) */
  live: boolean;
  sans: string[];
  /** coups en notation UCI (même ordre que sans) : analyse, flèches */
  ucis: string[];
  fen: string;
  /** secondes restantes, au moment `clockAt` */
  clocks: { w: number | null; b: number | null };
  clockAt: number;
  turn: Color;
}

/** Ronde d'un tournoi retransmis (pour rouvrir les parties déjà jouées). */
export interface RelayRoundRef {
  number: number;
  name: string;
  state: "finished" | "ongoing" | "upcoming" | "unknown";
  /** heure de début prévue (ms), si la source la donne */
  startsAt?: number | null;
}

/** Classement d'un tournoi retransmis (pour un match : le score des deux joueurs). */
export interface RelayStanding {
  name: string;
  title: string | null;
  /** points (1 par victoire, ½ par nulle) */
  score: number;
  played: number;
}

export interface RelaySummary {
  id: string;
  name: string;
  /** ronde suivie (0 = la plus récente automatiquement) */
  round: number;
  /** ronde réellement affichée */
  currentRound: number | null;
  /** nom de la ronde à la source (Lichess : « Game 3 »…), sinon null */
  roundName?: string | null;
  /** toutes les rondes connues (pour revoir les précédentes) */
  rounds?: RelayRoundRef[];
  /** classement (parties terminées), du meilleur au moins bon ; absent si la source ne le permet pas */
  standings?: RelayStanding[];
  games: number;
  live: boolean;
  updatedAt: number | null;
  error: string | null;
}

export interface RelayRoundView extends RelaySummary {
  tournamentName: string | null;
  gameList: RelayGameView[];
}

/** Pronostics en jetons sur une partie retransmise : cotes 1 / N / 2 calculées par Stockfish après chaque coup. */
export type PredictionPick = "white" | "draw" | "black";
export interface OddsView {
  relayId: string;
  round: number;
  index: number;
  /** une mise cite la version des cotes qu'elle a vues (refusée si un coup est arrivé entre-temps) */
  version: number;
  ply: number;
  odds: { white: number; draw: number; black: number } | null;
  probs: { white: number; draw: number; black: number } | null;
  suspended: boolean;
  closed: boolean;
  result: string | null;
}
export interface BetView {
  id: string;
  market: string;
  relayId: string;
  pick: PredictionPick;
  stakeCents: Cents;
  odds: number;
  ply: number;
  label: string;
  status: "open" | "won" | "lost" | "void";
  payoutCents: Cents;
  createdAt: string;
  settledAt: string | null;
}
export type BetPlaceAck = { ok: true; bet: BetView; balanceCents: Cents } | { ok: false; code: string };
export interface PredictionsMine {
  bets: BetView[];
  balanceCents: Cents;
  /** meilleurs pronostiqueurs du mois : gain net en jetons */
  leaders: Array<{ userId: string; netCents: Cents; bets: number; won: number }>;
}

export interface ServerToClientEvents {
  "queue:joined": (p: { timeControl: TimeControlId; stake: Stake }) => void;
  "queue:left": () => void;
  /** joueurs en attente par file « cadence|devise|mise » (pour se retrouver entre amis) */
  "queue:stats": (s: Record<string, number>) => void;
  "game:start": (p: GameStartEvent) => void;
  "game:state": (p: GameStateEvent) => void;
  "game:over": (p: GameOverEvent) => void;
  "game:presence": (p: PresenceEvent) => void;
  "game:draw": (p: DrawOfferEvent) => void;
  "game:net": (p: GameNetEvent) => void;
  /**
   * Sonde de latence initiée par le SERVEUR (ADR-8). Le RTT est mesuré côté serveur :
   * un client ne peut pas déclarer lui-même un faux lag pour gagner du temps.
   */
  "lag:probe": (serverTs: number, ack: (clientTs: number) => void) => void;
  "sng:update": (p: SngSnapshot) => void;
  "session:mode": (p: SessionModeEvent) => void;
  "sng:lobby": (p: SngSnapshot[]) => void;
  "error": (p: { code: ErrorCode; message: string }) => void;
  "chat:msg": (m: ChatMessage) => void;
  /** historique du chat des joueurs (reconnexion) */
  "chat:history": (p: { gameId: string; messages: ChatMessage[] }) => void;
  "game:spectators": (p: { gameId: string; count: number }) => void;
  "rematch": (p: RematchEvent) => void;
  /** défi reçu (aussi renvoyé à la connexion s'il est encore ouvert) */
  "challenge:incoming": (c: ChallengeView) => void;
  "challenge:update": (u: ChallengeUpdate) => void;
  /** retransmission : toute la ronde (arrivée, changement de ronde) puis chaque partie qui bouge */
  "relay:round": (r: RelayRoundView) => void;
  "relay:game": (p: { relayId: string; round: number; game: RelayGameView }) => void;
  /** nouvelles cotes d'une partie retransmise (après chaque coup) */
  "relay:odds": (v: OddsView) => void;
  /** un de mes pronostics est réglé */
  "bet:settled": (b: BetView) => void;
}

export interface ClientToServerEvents {
  "queue:join": (p: QueueJoinPayload) => void;
  "queue:leave": () => void;
  /** ack optionnel : permet l'UI optimiste avec rollback si le serveur refuse. */
  "game:move": (p: MovePayload, ack?: (r: MoveAck) => void) => void;
  "game:resign": (p: { gameId: string }) => void;
  /** Arena : berserk avant son premier coup */
  "game:berserk": (p: { gameId: string }) => void;
  "game:draw": (p: { gameId: string; action: DrawAction }) => void;
  "game:signal": (p: ClientSignalPayload) => void;
  /** synchro d'horloge pour l'AFFICHAGE (offset client↔serveur), sans effet sur l'arbitrage. */
  "time:ping": (clientTs: number, ack: (serverTs: number) => void) => void;
  "sng:list": (ack: (tables: SngSnapshot[]) => void) => void;
  "sng:register": (p: { formatId: string }, ack: (r: SngAck) => void) => void;
  "sng:unregister": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
  /** crée un tournoi (le créateur y est inscrit d'office) */
  "sng:create": (p: SngCreatePayload, ack: (r: SngAck) => void) => void;
  /** rejoint un tournoi précis (lien d'invitation) */
  "sng:join": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
  /** état d'un tournoi (page d'invitation, avant inscription) */
  "sng:get": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
  /** suivre un tournoi en direct sans y jouer (page du tournoi) */
  "sng:watch": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
  "sng:unwatch": (p: { tournamentId: string }) => void;
  /** le créateur lance son tournoi sans attendre qu'il soit complet (≥ 3 inscrits ; exempts au 1er tour) */
  "sng:start": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
  /** chat du tournoi : historique (les messages s'envoient par chat:send avec gameId « tournament:<id> ») */
  "sng:chat": (p: { tournamentId: string }, ack: (r: { ok: true; messages: ChatMessage[] } | { ok: false }) => void) => void;
  /** organisateur : retirer un inscrit avant le départ (remboursé, ne peut plus se réinscrire) */
  "sng:kick": (p: { tournamentId: string; userId: string }, ack: (r: SngAck) => void) => void;
  /** quitter un tournoi en cours (suisse : plus apparié ; arena : pause définitive) */
  "sng:withdraw": (p: { tournamentId: string }, ack: (r: SngAck) => void) => void;
  /** arena : se mettre en pause (plus de nouvel adversaire) ou reprendre */
  "sng:pause": (p: { tournamentId: string; paused: boolean }, ack: (r: SngAck) => void) => void;
  "chat:send": (p: { gameId: string; text: string }, ack?: (r: ChatAck) => void) => void;
  /** signaler un message à l'organisateur */
  "chat:report": (p: { gameId: string; messageId: number }, ack?: (r: { ok: boolean }) => void) => void;
  /** signaler son adversaire pour soupçon de triche (après la partie) */
  "cheat:report": (p: { gameId: string; reason: string }, ack?: (r: { ok: boolean; code?: string }) => void) => void;
  /** regarder une partie en cours */
  "watch:start": (p: { gameId: string }, ack: (r: WatchAck) => void) => void;
  "watch:stop": (p: { gameId: string }) => void;
  "watch:list": (ack: (games: LiveGameView[]) => void) => void;
  /** revanche : proposer (ou accepter si l'adversaire l'a déjà proposée), refuser / retirer */
  "rematch": (p: { gameId: string; action: "offer" | "decline" }, ack?: (r: RematchAck) => void) => void;
  /** défier un joueur (en ligne) à la cadence choisie, partie classée en jetons PLAY sans mise */
  "challenge:send": (p: { to: string; timeControl: TimeControlId }, ack: (r: ChallengeAck) => void) => void;
  "challenge:answer": (p: { id: string; accept: boolean }, ack?: (r: { ok: boolean; code?: string }) => void) => void;
  "challenge:cancel": (p: { id: string }) => void;
  /** défi par lien : créer (remplace le précédent), annuler, accepter (celui qui a ouvert le lien) */
  "link:create": (p: { timeControl: TimeControlId }, ack: (r: LinkChallengeAck) => void) => void;
  "link:cancel": () => void;
  "link:accept": (p: { code: string }, ack: (r: { ok: boolean; code?: string }) => void) => void;
  /** suivre une retransmission (chat : gameId « relay:<id> ») */
  "odds:list": (p: { relayId: string }, ack: (r: OddsView[]) => void) => void;
  "bet:place": (p: { relayId: string; round: number; index: number; pick: PredictionPick; stakeCents: Cents; version: number }, ack: (r: BetPlaceAck) => void) => void;
  "bet:mine": (ack: (r: PredictionsMine) => void) => void;
  "relay:watch": (p: { relayId: string }, ack: (r: { ok: true; round: RelayRoundView } | { ok: false; code: string }) => void) => void;
  "relay:unwatch": (p: { relayId: string }) => void;
  /** une ronde précise (déjà jouée) : envoyée une fois, sans suivi en direct */
  "relay:roundView": (p: { relayId: string; round: number }, ack: (r: { ok: true; round: RelayRoundView } | { ok: false; code: string }) => void) => void;
  /** analyse pédagogique d'une partie terminée : calculée une fois (dans un navigateur), partagée avec tous */
  "relay:review": (p: { relayId: string; round: number; index: number; plies: number }, ack: (r: { review: unknown | null }) => void) => void;
}

/** Claims du JWT émis par l'API d'auth (le game-server ne fait que vérifier). */
export interface ArenaJwtClaims {
  sub: string;
  /** Elo par cadence ; 1500 par défaut si absent */
  ratings?: Partial<Record<TimeControlId, number>>;
  country?: string;
  /** drapeau d'affichage public, choisi par le joueur (ISO alpha-2) */
  flag?: string;
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

// ─── Fichiers PGN (import de parties, base de maîtres) ───────────────────────
/** Une partie d'un fichier PGN, avant lecture des coups : ses en-têtes et le texte des coups. */
export interface PgnGameText { tags: Record<string, string>; movetext: string }

/** Découpe un fichier PGN (plusieurs parties, éventuellement exporté par ChessBase) en parties. */
export function splitPgnGames(text: string): PgnGameText[] {
  const out: PgnGameText[] = [];
  let cur: PgnGameText | null = null;
  let inMoves = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const tag = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/.exec(line);
    if (tag) {
      if (!cur || inMoves) { cur = { tags: {}, movetext: "" }; out.push(cur); inMoves = false; }
      cur.tags[tag[1]!] = tag[2]!.replace(/\\(.)/g, "$1");
      continue;
    }
    if (!line || line.startsWith("%")) continue;
    if (!cur) { cur = { tags: {}, movetext: "" }; out.push(cur); }
    inMoves = true;
    cur.movetext += `${line} `;
  }
  return out.filter((g) => g.movetext.trim() || Object.keys(g.tags).length);
}

/**
 * Les coups (SAN) de la ligne principale, sans commentaires, variantes, NAG ni numéros de coups.
 * Les annotations d'auteurs ne sont jamais gardées : seuls les coups et le résultat comptent.
 */
export function pgnMainline(movetext: string): string[] {
  let s = "";
  let depth = 0;
  for (let i = 0; i < movetext.length; i++) {
    const ch = movetext[i]!;
    if (ch === "{") { const j = movetext.indexOf("}", i); i = j < 0 ? movetext.length : j; s += " "; continue; }
    if (ch === ";") { const j = movetext.indexOf("\n", i); i = j < 0 ? movetext.length : j; s += " "; continue; }
    if (ch === "(") { depth++; s += " "; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); s += " "; continue; }
    if (depth === 0) s += ch;
  }
  const out: string[] = [];
  for (let t of s.split(/\s+/)) {
    t = t.replace(/^\d+\.+/, "");
    if (!t || /^\$\d+$/.test(t) || /^\d+\.*$/.test(t)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|½-½|\*)$/.test(t)) break;
    if (t === "--" || t === "Z0") break;
    t = t.replace(/[!?]+$/, "").replace(/^0-0-0/, "O-O-O").replace(/^0-0/, "O-O").replace(/e\.p\.$/, "");
    if (t) out.push(t);
  }
  return out;
}

/** Nom de joueur comparable entre deux écritures (« Carlsen, Magnus » = « Magnus Carlsen », sans accents ni casse). */
export function pgnPlayerKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).sort().join(" ");
}

/** Cadence d'une partie d'après l'en-tête TimeControl (« 5400+30 », « 180+2 »…) ; sans en-tête : partie longue (club, tournoi). */
export function pgnSpeed(tc: string | undefined): "bullet" | "blitz" | "rapid" | "classical" {
  const m = /^(\d+)(?:\+(\d+))?$/.exec((tc ?? "").trim());
  if (!m) return "classical";
  const est = Number(m[1]) + 40 * Number(m[2] ?? 0);
  return est < 180 ? "bullet" : est < 480 ? "blitz" : est < 1500 ? "rapid" : "classical";
}
