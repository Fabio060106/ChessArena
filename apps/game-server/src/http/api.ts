import type { IncomingMessage, ServerResponse } from "node:http";
import jwt from "jsonwebtoken";
import type pg from "pg";
import type { ArenaJwtClaims, DecisionRequest, RgLimitKind } from "@chessarena/shared";
import type { GameServerConfig } from "../config.js";
import { CaseAlreadyResolvedError, CaseNotFoundError, type ModerationService } from "../fairplay/ModerationService.js";
import { WithdrawalError, type WithdrawalService } from "../settlement/withdrawals.js";
import { ComplianceError, LimitExceededError, type LimitsService } from "../fairplay/limits.js";
import { KycError, KycService, verifyWebhook } from "../auth/kyc.js";
import { DepositError, type DepositService } from "../settlement/deposits.js";
import { LedgerError } from "../settlement/ledger.js";
import type { GeoFilter, KillSwitch } from "../net/geoFilter.js";
import { ExportError, type RegulatoryExporter } from "../audit/regulatoryExport.js";
import { TokenBucket } from "../net/rateLimiter.js";

/**
 * API REST du game-server (même port que le WebSocket).
 *
 *  Joueur (JWT)
 *   GET  /account/compliance                  KYC, limites (utilisé / plafond / hausse en attente), exclusion, mode de session
 *   PUT  /account/limits                      { kind, amountCents }      baisse immédiate, hausse à +48 h
 *   POST /account/self-exclusion              { days } | { permanent: true }
 *   GET  /kyc/status · POST /kyc/start
 *   POST /wallet/deposits                     { amountCents, pspRef }    SANDBOX uniquement (en prod : webhook PSP)
 *   GET  /wallet/withdrawals · POST /wallet/withdrawals { amountCents }   jamais géo-filtré
 *
 *  Prestataire KYC (signature HMAC, pas de JWT)
 *   POST /kyc/webhook                         en-tête `kyc-signature: t=…,v1=…`
 *
 *  Modération (role moderator|admin)
 *   GET  /admin/anticheat/cases[?status=]  ·  GET /admin/anticheat/cases/:id  ·  POST …/:id/decision
 *
 *  Conformité (role compliance|admin)
 *   GET  /admin/compliance/kill-switch
 *   POST /admin/compliance/kill-switch        { enabled, countries?, reason }
 *   POST /admin/compliance/kyc/:userId/review { approve, note }
 *   POST /admin/compliance/exports            { from, to }   → paquet signé
 *   GET  /admin/compliance/exports/public-key
 *
 * Sécurité (OWASP ASVS) : en-têtes durcis, corps ≤ 16 Ko, JSON strict, limitation de débit
 * par IP réelle (X-Forwarded-For seulement via proxy de confiance), réponses d'erreur sans
 * détail interne, autorisation par rôle vérifiée côté serveur à chaque requête.
 */
export interface ApiDeps {
  cfg: GameServerConfig;
  moderation: ModerationService | null;
  withdrawals: WithdrawalService | null;
  limits?: LimitsService | null;
  kyc?: KycService | null;
  deposits?: DepositService | null;
  killSwitch?: KillSwitch;
  geo?: GeoFilter;
  exporter?: RegulatoryExporter | null;
  pool?: pg.Pool | null;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function auth(req: IncomingMessage, cfg: GameServerConfig): ArenaJwtClaims {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ") || !cfg.jwtSecret) throw new HttpError(401, "UNAUTHORIZED");
  try {
    const c = jwt.verify(h.slice(7), cfg.jwtSecret, { algorithms: ["HS256"] }) as ArenaJwtClaims;
    if (typeof c.sub !== "string" || !/^[^:\s]{1,64}$/.test(c.sub)) throw new Error();
    return c;
  } catch {
    throw new HttpError(401, "UNAUTHORIZED");
  }
}

const isModerator = (c: ArenaJwtClaims) => c.role === "moderator" || c.role === "admin";
const isCompliance = (c: ArenaJwtClaims) => c.role === "compliance" || c.role === "admin";

async function rawBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = req.headers["content-type"] ?? "";
  if (req.method !== "GET" && !ct.startsWith("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  const raw = await rawBody(req);
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "BAD_JSON");
  }
}

const LIMIT_KINDS: readonly RgLimitKind[] = ["deposit_week", "stake_week", "stake_per_entry"];
const isCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// ─── Limitation de débit HTTP par IP ────────────────────────────────────────
const buckets = new Map<string, { b: TokenBucket; seen: number }>();
let lastSweep = Date.now();
function rateLimited(ip: string, cfg: GameServerConfig): boolean {
  const now = Date.now();
  if (now - lastSweep > 60_000) {                       // purge des IP inactives : mémoire bornée
    for (const [k, v] of buckets) if (now - v.seen > 300_000) buckets.delete(k);
    lastSweep = now;
  }
  let e = buckets.get(ip);
  if (!e) buckets.set(ip, (e = { b: new TokenBucket(cfg.httpRateLimit.burst, cfg.httpRateLimit.perSecond), seen: now }));
  e.seen = now;
  return !e.b.take();
}

function securityHeaders(res: ServerResponse, cfg: GameServerConfig): void {
  res.setHeader("access-control-allow-origin", cfg.corsOrigin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("cross-origin-resource-policy", "same-site");
  if (process.env.NODE_ENV === "production") res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
}

/** Retourne true si la requête a été prise en charge. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, d: ApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  if (!/^\/(admin|wallet|account|kyc)\//.test(url.pathname)) return false;

  securityHeaders(res, d.cfg);
  const send = (status: number, payload: unknown) => res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(payload));
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return true; }

  const origin = d.geo?.originOf(req.socket.remoteAddress, req.headers) ?? { ip: req.socket.remoteAddress ?? "", country: null, source: "none" as const };
  if (rateLimited(origin.ip, d.cfg)) {
    res.setHeader("retry-after", "1");
    send(429, { error: "RATE_LIMITED" });
    return true;
  }

  const need = <T>(v: T | null | undefined): T => {
    if (!v) throw new HttpError(503, "DATABASE_REQUIRED");
    return v;
  };

  try {
    // ─── Webhook KYC : authentifié par HMAC sur le corps BRUT (pas de JWT) ────────
    if (url.pathname === "/kyc/webhook" && req.method === "POST") {
      const kyc = need(d.kyc);
      if (!d.cfg.kycWebhookSecret) throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED");
      const raw = await rawBody(req, 64 * 1024);
      const sig = req.headers["kyc-signature"];
      verifyWebhook(d.cfg.kycWebhookSecret, raw, Array.isArray(sig) ? sig[0] : sig);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "BAD_JSON"); }
      const r = await kyc.applyProviderResult(KycService.parseWebhook(parsed));
      send(200, { received: true, duplicate: r.duplicate });
      return true;
    }

    const claims = auth(req, d.cfg);
    const sessionMode = async () => {
      if (!d.geo) return { mode: "PLAY_MONEY_ONLY" as const, reason: "REAL_MONEY_DISABLED" as const };
      const u = d.pool ? (await d.pool.query<{ country: string | null }>("SELECT country FROM users WHERE id = $1", [claims.sub])).rows[0] : undefined;
      const excluded = d.limits ? await d.limits.isExcluded(claims.sub) : false;
      return d.geo.modeFor(origin.country, u?.country ?? null, excluded);
    };

    // ─── Back-office anti-triche ───────────────────────────────────────────────
    if (url.pathname.startsWith("/admin/anticheat/")) {
      if (!isModerator(claims)) throw new HttpError(403, "FORBIDDEN");
      const moderation = need(d.moderation);
      if (req.method === "GET" && url.pathname === "/admin/anticheat/cases") {
        const status = url.searchParams.get("status") === "resolved" ? "resolved" : "open";
        send(200, await moderation.listCases(status));
        return true;
      }
      const m = url.pathname.match(/^\/admin\/anticheat\/cases\/([0-9a-f-]{36})(\/decision)?$/);
      if (m && req.method === "GET" && !m[2]) {
        send(200, await moderation.getCase(m[1]!));
        return true;
      }
      if (m && req.method === "POST" && m[2]) {
        const b = (await body(req)) as Partial<DecisionRequest>;
        if (!b.decision || !["clean", "watch", "cheat"].includes(b.decision)) throw new HttpError(400, "BAD_DECISION");
        if (typeof b.note !== "string" || b.note.trim().length < 5) throw new HttpError(400, "NOTE_REQUIRED");
        send(200, await moderation.decide(m[1]!, claims.sub, b.decision, b.note));
        return true;
      }
      throw new HttpError(404, "NOT_FOUND");
    }

    // ─── Back-office conformité ────────────────────────────────────────────────
    if (url.pathname.startsWith("/admin/compliance/")) {
      if (!isCompliance(claims)) throw new HttpError(403, "FORBIDDEN");
      if (url.pathname === "/admin/compliance/kill-switch") {
        const ks = need(d.killSwitch);
        if (req.method === "GET") { send(200, await ks.state()); return true; }
        if (req.method === "POST") {
          const b = await body(req);
          if (typeof b.enabled !== "boolean") throw new HttpError(400, "BAD_ENABLED");
          if (typeof b.reason !== "string" || b.reason.trim().length < 5) throw new HttpError(400, "REASON_REQUIRED");
          if (b.countries !== undefined && (!Array.isArray(b.countries) || b.countries.some((c) => typeof c !== "string" || !/^[A-Za-z]{2}$/.test(c)))) {
            throw new HttpError(400, "BAD_COUNTRIES");
          }
          send(200, await ks.set(claims.sub, { enabled: b.enabled, countries: b.countries as string[] | undefined }, b.reason));
          return true;
        }
      }
      const kr = url.pathname.match(/^\/admin\/compliance\/kyc\/([^/:\s]{1,64})\/review$/);
      if (kr && req.method === "POST") {
        const b = await body(req);
        if (typeof b.approve !== "boolean") throw new HttpError(400, "BAD_APPROVE");
        if (typeof b.note !== "string" || b.note.trim().length < 5) throw new HttpError(400, "NOTE_REQUIRED");
        send(200, { status: await need(d.kyc).review(decodeURIComponent(kr[1]!), claims.sub, b.approve, b.note) });
        return true;
      }
      if (url.pathname === "/admin/compliance/exports" && req.method === "POST") {
        const b = await body(req);
        const from = new Date(String(b.from)), to = new Date(String(b.to));
        const bundle = await need(d.exporter).generate(from, to, claims.sub);
        send(201, bundle);
        return true;
      }
      if (url.pathname === "/admin/compliance/exports/public-key" && req.method === "GET") {
        const ex = need(d.exporter);
        const { keyFingerprint } = await import("../audit/regulatoryExport.js");
        send(200, { publicKeyPem: ex.publicKeyPem, fingerprint: keyFingerprint(ex.publicKeyPem) });
        return true;
      }
      throw new HttpError(404, "NOT_FOUND");
    }

    // ─── Compte joueur : jeu responsable ─────────────────────────────────────────
    if (url.pathname === "/account/compliance" && req.method === "GET") {
      send(200, { ...(await need(d.limits).view(claims.sub)), session: await sessionMode() });
      return true;
    }
    if (url.pathname === "/account/limits" && req.method === "PUT") {
      const b = await body(req);
      if (!LIMIT_KINDS.includes(b.kind as RgLimitKind)) throw new HttpError(400, "BAD_KIND");
      if (!isCents(b.amountCents)) throw new HttpError(400, "BAD_AMOUNT");
      send(200, await need(d.limits).setLimit(claims.sub, b.kind as RgLimitKind, b.amountCents));
      return true;
    }
    if (url.pathname === "/account/self-exclusion" && req.method === "POST") {
      const b = await body(req);
      const limits = need(d.limits);
      if (b.permanent === true) { send(200, await limits.selfExclude(claims.sub, { permanent: true })); return true; }
      if (typeof b.days !== "number" || !Number.isInteger(b.days)) throw new HttpError(400, "BAD_DURATION");
      send(200, await limits.selfExclude(claims.sub, { durationMs: b.days * 86_400_000 }));
      return true;
    }

    // ─── KYC (joueur) ─────────────────────────────────────────────────────────────
    if (url.pathname === "/kyc/status" && req.method === "GET") {
      const s = await need(d.kyc).state(claims.sub);
      send(200, { status: s.status, attemptsLeft: Math.max(0, 3 - s.attempts) }); // pas de détail de revue côté joueur
      return true;
    }
    if (url.pathname === "/kyc/start" && req.method === "POST") {
      send(201, await need(d.kyc).start(claims.sub));
      return true;
    }

    // ─── Portefeuille ──────────────────────────────────────────────────────────
    if (url.pathname === "/wallet/deposits" && req.method === "POST") {
      // En production, un dépôt n'est crédité QUE sur notification signée du PSP.
      if (process.env.NODE_ENV === "production") throw new HttpError(404, "NOT_FOUND");
      const mode = await sessionMode();
      if (mode.mode !== "REAL_MONEY") throw new HttpError(403, mode.mode === "LOCKED" ? "SELF_EXCLUDED" : "PLAY_MONEY_ONLY");
      const b = await body(req);
      if (!isCents(b.amountCents)) throw new HttpError(400, "BAD_AMOUNT");
      if (typeof b.pspRef !== "string") throw new HttpError(400, "BAD_PSP_REF");
      send(201, await need(d.deposits).credit(claims.sub, b.amountCents, b.pspRef));
      return true;
    }
    if (url.pathname === "/wallet/withdrawals") {
      // Pas de géo-filtrage ni de kill-switch : un joueur récupère toujours son solde
      // (KYC, solde et garde-fous comptables restent exigés).
      const withdrawals = need(d.withdrawals);
      if (req.method === "GET") { send(200, await withdrawals.list(claims.sub)); return true; }
      if (req.method === "POST") {
        const b = await body(req);
        send(201, await withdrawals.request(claims.sub, Number(b.amountCents)));
        return true;
      }
    }
    throw new HttpError(404, "NOT_FOUND");
  } catch (e) {
    if (e instanceof HttpError) send(e.status, { error: e.code });
    else if (e instanceof CaseNotFoundError) send(404, { error: "CASE_NOT_FOUND" });
    else if (e instanceof CaseAlreadyResolvedError) send(409, { error: "CASE_ALREADY_RESOLVED" });
    else if (e instanceof WithdrawalError) send(e.code === "ACCOUNT_CLOSED" || e.code === "KYC_REQUIRED" ? 403 : 400, { error: e.code });
    else if (e instanceof DepositError) send(400, { error: e.code });
    else if (e instanceof LimitExceededError) send(422, { error: e.code, kind: e.kind, limitCents: e.limitCents, usedCents: e.usedCents });
    else if (e instanceof ComplianceError || e instanceof LedgerError) send(e instanceof ComplianceError && e.code === "INVALID_LIMIT" ? 400 : 403, { error: e.code });
    else if (e instanceof KycError) send(e.code === "BAD_SIGNATURE" || e.code === "STALE_WEBHOOK" ? 401 : e.code === "BAD_PAYLOAD" ? 400 : 409, { error: e.code });
    else if (e instanceof ExportError) send(e.code === "NO_SIGNING_KEY" || e.code === "BAD_KEY" ? 503 : 400, { error: e.code });
    else {
      console.error("[api]", e);
      send(500, { error: "INTERNAL" });
    }
    return true;
  }
}
