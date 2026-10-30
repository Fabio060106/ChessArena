import { timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * Accès bêta (en attendant la vraie authentification) : un code d'invitation partagé
 * (BETA_ACCESS_CODE) + un pseudo. La session est un cookie httpOnly signé (30 jours) ;
 * le jeton de jeu (15 min) en est dérivé à chaque connexion au serveur de jeu.
 *
 * Limite assumée : le pseudo n'est pas réservé. Deux personnes ayant le code peuvent
 * choisir le même pseudo. Suffisant pour une bêta fermée entre testeurs de confiance,
 * en jetons PLAY uniquement.
 */
export const SESSION_COOKIE = "arena_session";
const SESSION_AUDIENCE = "chessarena-web-session";
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

export interface BetaSession {
  userId: string;
  flag?: string;
}

export const PSEUDO_RE = /^[A-Za-z0-9_-]{3,20}$/;
export const FLAG_RE = /^[A-Za-z]{2}$/;

export function secret(): string | null {
  const s = process.env.JWT_SECRET ?? "";
  return s.length >= 32 ? s : null;
}

/** Comparaison en temps constant du code d'invitation. Faux si aucun code n'est configuré. */
export function checkAccessCode(given: string): boolean {
  const expected = process.env.BETA_ACCESS_CODE ?? "";
  if (expected.length < 6) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSession(s: BetaSession, key: string): string {
  return jwt.sign({ sub: s.userId, ...(s.flag ? { flag: s.flag } : {}) }, key, {
    algorithm: "HS256", audience: SESSION_AUDIENCE, expiresIn: SESSION_MAX_AGE_S,
  });
}

export function readSession(token: string | undefined, key: string): BetaSession | null {
  if (!token) return null;
  try {
    const c = jwt.verify(token, key, { algorithms: ["HS256"], audience: SESSION_AUDIENCE }) as jwt.JwtPayload & { flag?: string };
    if (typeof c.sub !== "string" || !PSEUDO_RE.test(c.sub)) return null;
    return { userId: c.sub, ...(typeof c.flag === "string" && FLAG_RE.test(c.flag) ? { flag: c.flag } : {}) };
  } catch {
    return null;
  }
}

/** Jeton de jeu court, lu par le game-server (mêmes claims que l'API d'auth définitive). */
export function signGameToken(s: BetaSession, key: string): string {
  return jwt.sign({ sub: s.userId, state: "active", kyc: false, ...(s.flag ? { flag: s.flag } : {}) }, key, {
    algorithm: "HS256", expiresIn: "15m",
  });
}
