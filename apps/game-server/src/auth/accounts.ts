import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type pg from "pg";

/**
 * Comptes joueurs (pseudo + mot de passe).
 *
 * - mot de passe haché avec scrypt (sel aléatoire de 16 octets, N=2^15) : jamais stocké ni journalisé en clair ;
 * - pseudo unique sans tenir compte de la casse ;
 * - les pseudos créés pendant la bêta « code d'invitation » (sans mot de passe) ne peuvent être réclamés
 *   qu'avec ce code (vérifié par le serveur web, qui seul le connaît) : personne ne peut prendre le pseudo
 *   et l'historique d'un testeur ;
 * - essais de connexion limités par pseudo et par adresse IP.
 *
 * Appelé uniquement par le serveur web (jeton de service), jamais directement par un navigateur.
 */

export const PSEUDO_RE = /^[A-Za-z0-9_-]{3,20}$/;
export const FLAG_RE = /^[A-Z]{2}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const RESERVED = /^(admin|administrateur|moderat(eur|or)|support|chessarena|system|root|arbitre)$/i;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEYLEN = 32;

function scrypt(pw: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((res, rej) => scryptCb(pw.normalize("NFKC"), salt, KEYLEN, opts, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// hachage factice pour que « pseudo inconnu » prenne autant de temps que « mauvais mot de passe »
let dummy: Promise<string> | null = null;

export interface AccountRow {
  id: string;
  passwordHash: string | null;
  flag: string | null;
  state: string;
}
export interface NewAccount { id: string; passwordHash: string; flag: string | null; email: string | null }

export interface AccountStore {
  /** compte par pseudo, sans tenir compte de la casse (le compte protégé par mot de passe en priorité) */
  find(pseudo: string): Promise<AccountRow | null>;
  /** crée le compte ; false si le pseudo (ou l'e-mail) est déjà pris */
  create(a: NewAccount): Promise<"ok" | "taken" | "email_taken">;
  /** pose le mot de passe d'un pseudo de la bêta qui n'en a pas encore ; false si quelqu'un l'a fait avant */
  claim(a: NewAccount): Promise<"ok" | "taken" | "email_taken">;
}

export type AccountErrorCode =
  | "BAD_PSEUDO" | "RESERVED_PSEUDO" | "WEAK_PASSWORD" | "BAD_EMAIL" | "CONSENT_REQUIRED"
  | "PSEUDO_TAKEN" | "EMAIL_TAKEN" | "CLAIM_CODE_REQUIRED" | "INVALID_CREDENTIALS" | "NO_PASSWORD_YET"
  | "TOO_MANY_ATTEMPTS" | "ACCOUNT_DISABLED";

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, readonly status = 400) { super(code); }
}

export interface SignupInput {
  pseudo: string; password: string; flag?: string | null; email?: string | null;
  adult: boolean; terms: boolean;
  /** le serveur web a vérifié le code de la bêta (pour réclamer un ancien pseudo) */
  betaCodeOk?: boolean;
  clientIp?: string;
}
export interface LoginInput { pseudo: string; password: string; clientIp?: string }
export interface SessionUser { userId: string; flag: string | null }

/** Fenêtre glissante d'échecs : au plus `max` échecs par clé sur `windowMs`. */
class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  blocked(key: string, now = Date.now()): boolean {
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (h.length) this.hits.set(key, h); else this.hits.delete(key);
    return h.length >= this.max;
  }
  fail(key: string, now = Date.now()) { this.hits.set(key, [...(this.hits.get(key) ?? []), now]); }
  reset(key: string) { this.hits.delete(key); }
}

export class AccountService {
  private byPseudo = new FailureLimiter(8, 15 * 60_000);
  private byIp = new FailureLimiter(30, 15 * 60_000);
  private signupsByIp = new FailureLimiter(20, 60 * 60_000); // 20 comptes / heure / IP : une famille ou un club sur le même Wi-Fi passe

  constructor(private store: AccountStore) {}

  async signup(i: SignupInput): Promise<SessionUser> {
    const pseudo = i.pseudo.trim();
    if (!PSEUDO_RE.test(pseudo)) throw new AccountError("BAD_PSEUDO");
    if (RESERVED.test(pseudo)) throw new AccountError("RESERVED_PSEUDO");
    if (typeof i.password !== "string" || i.password.length < PASSWORD_MIN || i.password.length > PASSWORD_MAX
      || i.password.toLowerCase() === pseudo.toLowerCase()) throw new AccountError("WEAK_PASSWORD");
    const email = i.email?.trim() || null;
    if (email && !EMAIL_RE.test(email)) throw new AccountError("BAD_EMAIL");
    if (!i.adult || !i.terms) throw new AccountError("CONSENT_REQUIRED");
    const flag = i.flag && FLAG_RE.test(i.flag) ? i.flag : null;
    const ip = i.clientIp ?? "";
    if (ip && this.signupsByIp.blocked(ip)) throw new AccountError("TOO_MANY_ATTEMPTS", 429);

    const existing = await this.store.find(pseudo);
    const a: NewAccount = { id: existing?.id ?? pseudo, passwordHash: await hashPassword(i.password), flag, email };
    let r: "ok" | "taken" | "email_taken";
    if (!existing) r = await this.store.create(a);
    else if (existing.passwordHash) r = "taken";
    else {
      // pseudo de la bêta : seulement avec le code, et avec exactement la même orthographe
      if (existing.id !== pseudo) r = "taken";
      else if (!i.betaCodeOk) throw new AccountError("CLAIM_CODE_REQUIRED", 403);
      else r = await this.store.claim(a);
    }
    if (r === "taken") throw new AccountError("PSEUDO_TAKEN", 409);
    if (r === "email_taken") throw new AccountError("EMAIL_TAKEN", 409);
    if (ip) this.signupsByIp.fail(ip); // compte créé : compte aussi dans le quota d'inscriptions par IP
    return { userId: a.id, flag };
  }

  async login(i: LoginInput): Promise<SessionUser> {
    const pseudo = String(i.pseudo ?? "").trim();
    const kp = pseudo.toLowerCase();
    const ip = i.clientIp ?? "";
    if (this.byPseudo.blocked(kp) || (ip && this.byIp.blocked(ip))) throw new AccountError("TOO_MANY_ATTEMPTS", 429);
    const acc = PSEUDO_RE.test(pseudo) ? await this.store.find(pseudo) : null;
    if (acc && !acc.passwordHash) throw new AccountError("NO_PASSWORD_YET", 401);
    const ok = acc?.passwordHash
      ? await verifyPassword(String(i.password ?? ""), acc.passwordHash)
      : (await verifyPassword(String(i.password ?? ""), await (dummy ??= hashPassword("x".repeat(12)))), false);
    if (!ok || !acc) {
      this.byPseudo.fail(kp);
      if (ip) this.byIp.fail(ip);
      throw new AccountError("INVALID_CREDENTIALS", 401);
    }
    if (acc.state === "closed" || acc.state === "banned") throw new AccountError("ACCOUNT_DISABLED", 403);
    this.byPseudo.reset(kp);
    return { userId: acc.id, flag: acc.flag };
  }
}

// ─── Stockage ────────────────────────────────────────────────────────────────

export class PgAccountStore implements AccountStore {
  constructor(private pool: pg.Pool) {}

  async find(pseudo: string): Promise<AccountRow | null> {
    const r = await this.pool.query<{ id: string; password_hash: string | null; display_flag: string | null; state: string }>(
      `SELECT id, password_hash, display_flag, state::text AS state FROM users WHERE lower(id) = lower($1)
       ORDER BY (password_hash IS NOT NULL) DESC, (id = $1) DESC LIMIT 1`, [pseudo]);
    const row = r.rows[0];
    return row ? { id: row.id, passwordHash: row.password_hash, flag: row.display_flag, state: row.state } : null;
  }

  async create(a: NewAccount): Promise<"ok" | "taken" | "email_taken"> {
    try {
      // verrou consultatif par pseudo (minuscules) : deux inscriptions simultanées ne créent pas « Bob » et « bob »
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", [a.id]);
        const dup = await client.query("SELECT 1 FROM users WHERE lower(id) = lower($1)", [a.id]);
        if (dup.rowCount) { await client.query("ROLLBACK"); return "taken"; }
        await client.query(
          `INSERT INTO users (id, username, email, password_hash, display_flag, terms_accepted_at, adult_confirmed_at)
           VALUES ($1, $1, $2, $3, $4, now(), now())`, [a.id, a.email, a.passwordHash, a.flag]);
        await client.query("COMMIT");
        return "ok";
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { client.release(); }
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return String((e as { constraint?: string }).constraint ?? "").includes("email") ? "email_taken" : "taken";
      throw e;
    }
  }

  async claim(a: NewAccount): Promise<"ok" | "taken" | "email_taken"> {
    try {
      const r = await this.pool.query(
        `UPDATE users SET password_hash = $2, display_flag = $3, email = COALESCE($4, email),
                terms_accepted_at = now(), adult_confirmed_at = now()
         WHERE id = $1 AND password_hash IS NULL`, [a.id, a.passwordHash, a.flag, a.email]);
      return r.rowCount === 1 ? "ok" : "taken";
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return "email_taken";
      throw e;
    }
  }
}

/** Sans base de données (développement, tests). */
export class InMemoryAccountStore implements AccountStore {
  rows = new Map<string, AccountRow & { email: string | null }>();
  async find(pseudo: string): Promise<AccountRow | null> {
    const all = [...this.rows.values()].filter((r) => r.id.toLowerCase() === pseudo.toLowerCase());
    all.sort((a, b) => Number(!!b.passwordHash) - Number(!!a.passwordHash) || Number(b.id === pseudo) - Number(a.id === pseudo));
    return all[0] ?? null;
  }
  async create(a: NewAccount): Promise<"ok" | "taken" | "email_taken"> {
    if (await this.find(a.id)) return "taken";
    if (a.email && [...this.rows.values()].some((r) => r.email?.toLowerCase() === a.email!.toLowerCase())) return "email_taken";
    this.rows.set(a.id, { id: a.id, passwordHash: a.passwordHash, flag: a.flag, state: "active", email: a.email });
    return "ok";
  }
  async claim(a: NewAccount): Promise<"ok" | "taken" | "email_taken"> {
    const r = this.rows.get(a.id);
    if (!r || r.passwordHash) return "taken";
    this.rows.set(a.id, { ...r, passwordHash: a.passwordHash, flag: a.flag, email: a.email ?? r.email });
    return "ok";
  }
  /** pseudo créé pendant la bêta (sans mot de passe) */
  seedBeta(id: string) { this.rows.set(id, { id, passwordHash: null, flag: null, state: "active", email: null }); }
}
