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
const RESERVED = /^(admin|administrateur|moderat(eur|or)|support|chessarena|chessaurum|system|root|arbitre)$/i;

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
  setPassword(id: string, passwordHash: string): Promise<void>;
  /** nouveau code de réinitialisation (les précédents non utilisés sont annulés) */
  createReset(id: string, codeHash: string, by: string, expiresAt: Date): Promise<void>;
  /** dernier code encore valable (non utilisé, non expiré) */
  activeReset(id: string): Promise<{ resetId: string; codeHash: string } | null>;
  /** marque le code utilisé ET pose le nouveau mot de passe, atomiquement ; false si déjà utilisé entre-temps */
  consumeReset(resetId: string, id: string, passwordHash: string): Promise<boolean>;
}

export type AccountErrorCode =
  | "BAD_PSEUDO" | "RESERVED_PSEUDO" | "WEAK_PASSWORD" | "BAD_EMAIL" | "CONSENT_REQUIRED"
  | "PSEUDO_TAKEN" | "EMAIL_TAKEN" | "CLAIM_CODE_REQUIRED" | "INVALID_CREDENTIALS" | "NO_PASSWORD_YET"
  | "TOO_MANY_ATTEMPTS" | "ACCOUNT_DISABLED" | "BAD_RESET_CODE" | "NOT_ADMIN" | "UNKNOWN_PLAYER";

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
  private signupsByIp: FailureLimiter;
  private resetsByPseudo = new FailureLimiter(5, 60 * 60_000);

  /** `signupsPerIpHour` : un club ou une salle de tournoi partagent la même adresse IP (défaut 60). */
  constructor(private store: AccountStore, opts: { signupsPerIpHour?: number } = {}) {
    this.signupsByIp = new FailureLimiter(opts.signupsPerIpHour ?? 60, 60 * 60_000);
  }

  private static checkPassword(pw: unknown, pseudo: string): string {
    if (typeof pw !== "string" || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX || pw.toLowerCase() === pseudo.toLowerCase()) {
      throw new AccountError("WEAK_PASSWORD");
    }
    return pw;
  }

  /** Compte par pseudo (casse indifférente). */
  find(pseudo: string): Promise<AccountRow | null> {
    return this.store.find(String(pseudo ?? "").trim());
  }

  /** Changer son mot de passe (joueur connecté) : l'ancien est exigé. */
  async changePassword(i: { userId: string; current: string; next: string }): Promise<void> {
    const kp = i.userId.toLowerCase();
    if (this.byPseudo.blocked(kp)) throw new AccountError("TOO_MANY_ATTEMPTS", 429);
    const acc = await this.store.find(i.userId);
    if (!acc || acc.id !== i.userId || !acc.passwordHash) throw new AccountError("INVALID_CREDENTIALS", 401);
    if (!(await verifyPassword(String(i.current ?? ""), acc.passwordHash))) {
      this.byPseudo.fail(kp);
      throw new AccountError("INVALID_CREDENTIALS", 401);
    }
    await this.store.setPassword(acc.id, await hashPassword(AccountService.checkPassword(i.next, acc.id)));
  }

  /**
   * L'organisateur génère un code de réinitialisation à donner au joueur (en main propre, par message…).
   * Code de 8 caractères sans ambiguïté (pas de 0/O, 1/I), valable 48 h, à usage unique.
   */
  async issueResetCode(i: { target: string; by: string }): Promise<{ userId: string; code: string; expiresAt: string }> {
    const acc = await this.store.find(String(i.target ?? "").trim());
    if (!acc) throw new AccountError("UNKNOWN_PLAYER", 404);
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(Date.now() + 48 * 3600_000);
    await this.store.createReset(acc.id, await hashPassword(raw), i.by, expiresAt);
    return { userId: acc.id, code, expiresAt: expiresAt.toISOString() };
  }

  /** Le joueur choisit un nouveau mot de passe avec le code reçu. */
  async resetWithCode(i: { pseudo: string; code: string; password: string; clientIp?: string }): Promise<SessionUser> {
    const pseudo = String(i.pseudo ?? "").trim();
    const kp = pseudo.toLowerCase();
    const ip = i.clientIp ?? "";
    if (this.resetsByPseudo.blocked(kp) || (ip && this.byIp.blocked(ip))) throw new AccountError("TOO_MANY_ATTEMPTS", 429);
    const acc = await this.store.find(pseudo);
    const reset = acc ? await this.store.activeReset(acc.id) : null;
    const code = String(i.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const ok = reset ? await verifyPassword(code, reset.codeHash) : (await verifyPassword(code, await (dummy ??= hashPassword("x".repeat(12)))), false);
    if (!ok || !acc || !reset) {
      this.resetsByPseudo.fail(kp);
      if (ip) this.byIp.fail(ip);
      throw new AccountError("BAD_RESET_CODE", 400);
    }
    if (acc.state === "closed" || acc.state === "banned") throw new AccountError("ACCOUNT_DISABLED", 403);
    const hash = await hashPassword(AccountService.checkPassword(i.password, acc.id));
    if (!(await this.store.consumeReset(reset.resetId, acc.id, hash))) throw new AccountError("BAD_RESET_CODE", 400);
    this.resetsByPseudo.reset(kp);
    this.byPseudo.reset(kp);
    return { userId: acc.id, flag: acc.flag };
  }

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

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
  }

  async createReset(id: string, codeHash: string, by: string, expiresAt: Date): Promise<void> {
    await this.pool.query("UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [id]);
    await this.pool.query("INSERT INTO password_resets (user_id, code_hash, created_by, expires_at) VALUES ($1,$2,$3,$4)", [id, codeHash, by, expiresAt]);
  }

  async activeReset(id: string): Promise<{ resetId: string; codeHash: string } | null> {
    const r = await this.pool.query<{ id: string; code_hash: string }>(
      "SELECT id, code_hash FROM password_resets WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1", [id]);
    return r.rows[0] ? { resetId: String(r.rows[0].id), codeHash: r.rows[0].code_hash } : null;
  }

  async consumeReset(resetId: string, id: string, passwordHash: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query("UPDATE password_resets SET used_at = now() WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now()", [resetId, id]);
      if (u.rowCount !== 1) { await client.query("ROLLBACK"); return false; }
      await client.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
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
  resets: Array<{ resetId: string; id: string; codeHash: string; expiresAt: number; used: boolean }> = [];
  async setPassword(id: string, passwordHash: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.passwordHash = passwordHash;
  }
  async createReset(id: string, codeHash: string, _by: string, expiresAt: Date): Promise<void> {
    for (const x of this.resets) if (x.id === id) x.used = true;
    this.resets.push({ resetId: String(this.resets.length + 1), id, codeHash, expiresAt: +expiresAt, used: false });
  }
  async activeReset(id: string): Promise<{ resetId: string; codeHash: string } | null> {
    const r = [...this.resets].reverse().find((x) => x.id === id && !x.used && x.expiresAt > Date.now());
    return r ? { resetId: r.resetId, codeHash: r.codeHash } : null;
  }
  async consumeReset(resetId: string, id: string, passwordHash: string): Promise<boolean> {
    const r = this.resets.find((x) => x.resetId === resetId && x.id === id && !x.used);
    if (!r) return false;
    r.used = true;
    await this.setPassword(id, passwordHash);
    return true;
  }
  /** pseudo créé pendant la bêta (sans mot de passe) */
  seedBeta(id: string) { this.rows.set(id, { id, passwordHash: null, flag: null, state: "active", email: null }); }
}
