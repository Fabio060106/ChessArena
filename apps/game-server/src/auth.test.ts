import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { defaultConfig, type GameServerConfig } from "./config.js";
import type { SessionModeEvent } from "@chessarena/shared";
import { authenticate, canPlay, type AuthUser } from "./auth.js";
import { parseMove, parseQueueJoin } from "./validation.js";
import { TokenBucket } from "./net/rateLimiter.js";
import { LagTracker } from "./net/lagTracker.js";

const SECRET = "test-secret-test-secret-test-secret!";
const cfg: GameServerConfig = { ...defaultConfig, jwtSecret: SECRET };

describe("authenticate", () => {
  it("accepte un JWT valide et normalise les claims", () => {
    const token = jwt.sign({ sub: "u1", ratings: { blitz_3_0: 1720, bullet_1_0: 99999 }, country: "fr", kyc: true }, SECRET);
    const u = authenticate({ token }, cfg);
    expect(u).toMatchObject({ userId: "u1", country: "FR", state: "active", kycVerified: true });
    expect(u.ratings.blitz_3_0).toBe(1720);
    expect(u.ratings.bullet_1_0).toBe(1500); // valeur aberrante ignorée
    expect(u.ratings.rapid_5_0).toBe(1500);
  });

  it("refuse : absent, mauvaise signature, expiré, sans sub, alg none", () => {
    expect(() => authenticate({}, cfg)).toThrow("token manquant");
    expect(() => authenticate({ token: jwt.sign({ sub: "u" }, "autre-secret") }, cfg)).toThrow("token invalide");
    expect(() => authenticate({ token: jwt.sign({ sub: "u", exp: Math.floor(Date.now() / 1000) - 10 }, SECRET) }, cfg)).toThrow("token expiré");
    expect(() => authenticate({ token: jwt.sign({ foo: 1 }, SECRET) }, cfg)).toThrow("sub manquant");
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"u"}').toString("base64url")}.`;
    expect(() => authenticate({ token: unsigned }, cfg)).toThrow("token invalide");
  });

  it("DEV_AUTH : userId en clair accepté seulement si activé", () => {
    expect(() => authenticate({ userId: "alice" }, cfg)).toThrow();
    expect(authenticate({ userId: "alice" }, { ...cfg, devAuth: true }).userId).toBe("alice");
  });
});

describe("canPlay (ADR-9)", () => {
  const base: AuthUser = {
    userId: "u", ratings: {} as AuthUser["ratings"], country: "FR", state: "active", kycVerified: true,
  };
  const REAL: SessionModeEvent = { mode: "REAL_MONEY", reason: "OK" };
  const off: SessionModeEvent = { mode: "PLAY_MONEY_ONLY", reason: "REAL_MONEY_DISABLED" };

  it("PLAY autorisé pour tout compte actif, même sans KYC ni argent réel", () => {
    expect(canPlay({ ...base, kycVerified: false }, "PLAY", off)).toEqual({ ok: true });
    expect(canPlay({ ...base, state: "withdrawal_hold" }, "PLAY", off)).toEqual({ ok: true });
  });

  it("auto-exclusion : AUCUN jeu, même en jetons PLAY", () => {
    expect(canPlay(base, "PLAY", { mode: "LOCKED", reason: "SELF_EXCLUDED" })).toEqual({ ok: false, code: "SELF_EXCLUDED" });
    expect(canPlay({ ...base, state: "self_excluded" }, "PLAY", REAL)).toEqual({ ok: false, code: "SELF_EXCLUDED" });
  });

  it("compte suspendu ou fermé : rien du tout", () => {
    expect(canPlay({ ...base, state: "suspended" }, "PLAY", REAL)).toEqual({ ok: false, code: "ACCOUNT_SUSPENDED" });
    expect(canPlay({ ...base, state: "closed" }, "PLAY", REAL)).toEqual({ ok: false, code: "ACCOUNT_SUSPENDED" });
  });

  it("EUR : mode de session (kill-switch, juridiction), puis KYC", () => {
    expect(canPlay(base, "EUR", off)).toEqual({ ok: false, code: "REAL_MONEY_DISABLED" });
    expect(canPlay(base, "EUR", { mode: "PLAY_MONEY_ONLY", reason: "JURISDICTION_BLOCKED" })).toEqual({ ok: false, code: "JURISDICTION_BLOCKED" });
    expect(canPlay(base, "EUR", { mode: "PLAY_MONEY_ONLY", reason: "UNKNOWN_LOCATION" })).toEqual({ ok: false, code: "PLAY_MONEY_ONLY" });
    expect(canPlay({ ...base, kycVerified: false }, "EUR", REAL)).toEqual({ ok: false, code: "KYC_REQUIRED_OR_ACCOUNT_HELD" });
    expect(canPlay(base, "EUR", REAL)).toEqual({ ok: true });
    expect(canPlay({ ...base, state: "withdrawal_hold" }, "EUR", REAL)).toEqual({ ok: true });
  });
});

describe("validation des payloads", () => {
  it("queue:join", () => {
    expect(parseQueueJoin({ timeControl: "blitz_3_2", stake: { currency: "PLAY", buyInCents: 200 } })).not.toBeNull();
    expect(parseQueueJoin({ timeControl: "blitz_9_9", stake: { currency: "PLAY", buyInCents: 200 } })).toBeNull();
    expect(parseQueueJoin({ timeControl: "blitz_3_0", stake: { currency: "BTC", buyInCents: 200 } })).toBeNull();
    expect(parseQueueJoin({ timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: 1.5 } })).toBeNull();
    expect(parseQueueJoin({ timeControl: "blitz_3_0", stake: { currency: "PLAY", buyInCents: -1 } })).toBeNull();
    expect(parseQueueJoin(null)).toBeNull();
  });
  it("game:move", () => {
    expect(parseMove({ gameId: "g", uci: "e2e4", ply: 0 })).toEqual({ gameId: "g", uci: "e2e4", ply: 0 });
    expect(parseMove({ gameId: "g", uci: "e2e4", ply: -1 })).toBeNull();
    expect(parseMove({ gameId: "g", uci: { $gt: "" }, ply: 0 })).toBeNull();
    expect(parseMove({ gameId: "x".repeat(65), uci: "e2e4", ply: 0 })).toBeNull();
  });
});

describe("réseau", () => {
  it("TokenBucket : burst puis débit soutenu", () => {
    let t = 0;
    const b = new TokenBucket(3, 2, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t += 500;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it("LagTracker : retient le meilleur RTT récent (résiste aux acks retardés exprès)", () => {
    const l = new LagTracker(3);
    expect(l.oneWayMs).toBe(0);
    [120, 80, 900].forEach((r) => l.addRtt(r));
    expect(l.oneWayMs).toBe(40);
    [900, 900, 900].forEach((r) => l.addRtt(r));
    expect(l.oneWayMs).toBe(450);
    l.addRtt(-5);
    l.addRtt(Number.NaN);
    expect(l.oneWayMs).toBe(450);
  });
});
