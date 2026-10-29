import jwt from "jsonwebtoken";
import {
  DEFAULT_RATING, TIME_CONTROLS,
  type AccountState, type ArenaJwtClaims, type Currency, type ErrorCode, type SessionModeEvent, type TimeControlId,
} from "@chessarena/shared";
import type { GameServerConfig } from "./config.js";

export interface AuthUser {
  userId: string;
  ratings: Record<TimeControlId, number>;
  /** ISO-3166, issu du KYC — jamais déclaratif */
  country: string;
  state: AccountState;
  kycVerified: boolean;
}

const ACCOUNT_STATES: readonly AccountState[] = ["active", "withdrawal_hold", "suspended", "self_excluded", "closed"];

function normalizeRatings(r: unknown): Record<TimeControlId, number> {
  const out = {} as Record<TimeControlId, number>;
  for (const tc of Object.keys(TIME_CONTROLS) as TimeControlId[]) {
    const v = (r as Record<string, unknown> | undefined)?.[tc];
    out[tc] = typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 3500 ? Math.round(v) : DEFAULT_RATING;
  }
  return out;
}

export class AuthError extends Error {}

/**
 * Le JWT est émis par l'API d'auth (NextAuth) après login, durée de vie courte
 * (15 min) ; le client le renouvelle et se reconnecte. Le game-server ne fait que
 * VÉRIFIER : les droits (KYC, état du compte, pays) viennent du token, pas du client.
 */
export function authenticate(handshakeAuth: Record<string, unknown>, cfg: GameServerConfig): AuthUser {
  if (cfg.devAuth && typeof handshakeAuth.userId === "string" && handshakeAuth.userId.length > 0) {
    const userId = handshakeAuth.userId.slice(0, 64);
    if (!/^[^:\s]+$/.test(userId)) throw new AuthError("userId invalide");
    const rating = Number(handshakeAuth.rating ?? DEFAULT_RATING);
    const ratings = normalizeRatings(Object.fromEntries(Object.keys(TIME_CONTROLS).map((k) => [k, rating])));
    return { userId, ratings, country: "FR", state: "active", kycVerified: false };
  }

  const token = handshakeAuth.token;
  if (typeof token !== "string" || token.length === 0) throw new AuthError("token manquant");
  if (!cfg.jwtSecret) throw new AuthError("JWT non configuré");

  let claims: ArenaJwtClaims & jwt.JwtPayload;
  try {
    claims = jwt.verify(token, cfg.jwtSecret, { algorithms: ["HS256"] }) as ArenaJwtClaims & jwt.JwtPayload;
  } catch (e) {
    throw new AuthError(e instanceof jwt.TokenExpiredError ? "token expiré" : "token invalide");
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new AuthError("sub manquant");
  // le `sub` sert de segment de nom de compte comptable (user:<sub>:<CUR>)
  if (!/^[^:\s]{1,64}$/.test(claims.sub)) throw new AuthError("sub invalide");

  return {
    userId: claims.sub,
    ratings: normalizeRatings(claims.ratings),
    country: typeof claims.country === "string" ? claims.country.toUpperCase() : "",
    state: ACCOUNT_STATES.includes(claims.state as AccountState) ? (claims.state as AccountState) : "active",
    kycVerified: claims.kyc === true,
  };
}

export type Gate = { ok: true } | { ok: false; code: ErrorCode };

/**
 * Porte d'accès UNIQUE (ADR-9), appelée à chaque `queue:join` / `sng:register`.
 * Le mode de session est calculé par le géo-filtre (kill-switch, IP, résidence, auto-exclusion).
 *
 *  | état / mode            | PLAY | EUR                                 |
 *  |------------------------|------|-------------------------------------|
 *  | suspended / closed     | non  | non                                 |
 *  | LOCKED (auto-exclusion)| non  | non  — consultation et retraits seuls|
 *  | PLAY_MONEY_ONLY        | oui  | non  (motif du géo-filtre)           |
 *  | REAL_MONEY             | oui  | si KYC vérifié                       |
 *  | withdrawal_hold        | oui  | oui (retraits bloqués, jeu autorisé) |
 *
 * Les limites de jeu responsable (mise par partie, cumul hebdomadaire) sont vérifiées
 * ensuite, et surtout DANS la transaction comptable qui bloque la mise.
 */
export function canPlay(user: AuthUser, currency: Currency, mode: SessionModeEvent): Gate {
  if (user.state === "suspended" || user.state === "closed") return { ok: false, code: "ACCOUNT_SUSPENDED" };
  if (mode.mode === "LOCKED" || user.state === "self_excluded") return { ok: false, code: "SELF_EXCLUDED" };
  if (currency === "PLAY") return { ok: true };
  if (mode.mode !== "REAL_MONEY") {
    if (mode.reason === "REAL_MONEY_DISABLED") return { ok: false, code: "REAL_MONEY_DISABLED" };
    if (mode.reason === "JURISDICTION_BLOCKED" || mode.reason === "RESIDENCE_BLOCKED") return { ok: false, code: "JURISDICTION_BLOCKED" };
    return { ok: false, code: "PLAY_MONEY_ONLY" };
  }
  if (!user.kycVerified) return { ok: false, code: "KYC_REQUIRED_OR_ACCOUNT_HELD" };
  return { ok: true };
}
