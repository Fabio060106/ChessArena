import type { IncomingMessage, ServerResponse } from "node:http";
import jwt from "jsonwebtoken";
import type pg from "pg";
import type { RelayService } from "../relay/RelayService.js";
import { REVIEW_MAX_BYTES, reviewStoreKey, validReview, type ReviewStore } from "../relay/ReviewStore.js";
import { REPERTOIRE_MAX_BYTES, SETTINGS_MAX_BYTES, type GameRepository } from "../persistence/GameRepository.js";
import { TIME_CONTROLS, type ArenaJwtClaims, type DecisionRequest, type RgLimitKind, type TimeControlId } from "@chessarena/shared";
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
import { AccountError, type AccountService } from "../auth/accounts.js";

/** Audience du jeton de service émis par le serveur web pour les routes /auth/* (jamais par un navigateur). */
export const AUTH_SERVICE_AUDIENCE = "chessarena-auth-service";

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
  /** historique des parties */
  repo?: GameRepository | null;
  /** comptes joueurs (pseudo + mot de passe) */
  accounts?: AccountService | null;
  /** partie en cours d'un joueur (profil : bouton « Regarder ») */
  liveGameOf?: (userId: string) => string | null;
  /** modération du chat : privés de chat (mis à jour à chaud) */
  chatMuted?: Set<string>;
  /** signalements gardés en mémoire quand il n'y a pas de base */
  memoryReports?: Array<{ reporter: string; reported: string; gameId: string; message: string; at: string }>;
  /** anti-triche de base sans base de données (tests, développement) */
  fairplayMem?: {
    signals: Array<{ gameId: string; userId: string; white: string; black: string; result: string; timeControl: string; reasons: string[]; focusLosses: number; timeCv: number | null; moves: number; flagged: boolean; at: string; reviewed: boolean }>;
    reports: Array<{ reporter: string; reported: string; gameId: string; reason: string; at: string; reviewed: boolean }>;
  };
  /** coupe immédiatement les connexions d'un joueur (compte suspendu) */
  kickUser?: (userId: string) => void;
  /** joueur connecté en ce moment (liste d'amis) */
  isOnline?: (userId: string) => boolean;
  /** retransmissions de tournois officiels */
  relays?: RelayService;
  /** analyses pédagogiques partagées des parties retransmises */
  reviews?: ReviewStore;
  /** lien d'une retransmission (LiveChessCloud ou Lichess) → source */
  parseRelaySource?: (raw: string) => { source: "lcc" | "lichess"; id: string; round: number } | null;
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
    if ((c as { aud?: unknown }).aud !== undefined) throw new Error(); // ni session web ni jeton de service
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

async function body(req: IncomingMessage, limit?: number): Promise<Record<string, unknown>> {
  const ct = req.headers["content-type"] ?? "";
  if (req.method !== "GET" && !ct.startsWith("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  const raw = await rawBody(req, limit);
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
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
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
  if (!/^\/(admin|wallet|account|kyc|auth)\//.test(url.pathname)) return false;

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

    // ─── Comptes : appelés par le serveur web avec un jeton de service ─────────────
    if (url.pathname.startsWith("/auth/")) {
      if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const h = req.headers.authorization;
      try {
        if (!h?.startsWith("Bearer ") || !d.cfg.jwtSecret) throw new Error();
        jwt.verify(h.slice(7), d.cfg.jwtSecret, { algorithms: ["HS256"], audience: AUTH_SERVICE_AUDIENCE });
      } catch { throw new HttpError(401, "UNAUTHORIZED"); }
      const accounts = need(d.accounts);
      const b = await body(req);
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      const clientIp = str(b.clientIp).slice(0, 64);
      const isAdmin = (u: string) => d.cfg.adminUsers.some((a) => a.toLowerCase() === u.toLowerCase());
      try {
        // ─── mot de passe ───
        if (url.pathname === "/auth/password/change") {
          await accounts.changePassword({ userId: str(b.userId), current: str(b.current), next: str(b.next) });
          send(200, { ok: true });
          return true;
        }
        if (url.pathname === "/auth/password/reset") {
          send(200, await accounts.resetWithCode({ pseudo: str(b.pseudo), code: str(b.code), password: str(b.password), clientIp }));
          return true;
        }
        // ─── organisateur (le serveur web transmet le pseudo connecté dans `by`) ───
        if (url.pathname.startsWith("/auth/admin/")) {
          const by = str(b.by);
          if (url.pathname === "/auth/admin/check") { send(200, { admin: isAdmin(by) }); return true; }
          if (!isAdmin(by)) throw new AccountError("NOT_ADMIN", 403);
          if (url.pathname === "/auth/admin/reset-code") {
            send(200, await accounts.issueResetCode({ target: str(b.target), by }));
            return true;
          }
          if (url.pathname === "/auth/admin/reports") {
            const reports = d.pool
              ? (await d.pool.query<{ id: string; reporter_id: string; reported_id: string; game_id: string; message: string; created_at: Date }>(
                  "SELECT id, reporter_id, reported_id, game_id, message, created_at FROM chat_reports WHERE handled_at IS NULL ORDER BY created_at DESC LIMIT 100")).rows
                  .map((r) => ({ id: String(r.id), reporter: r.reporter_id, reported: r.reported_id, gameId: r.game_id, message: r.message, at: r.created_at.toISOString() }))
              : (d.memoryReports ?? []).map((r, i) => ({ id: String(i), ...r }));
            send(200, { reports, muted: [...(d.chatMuted ?? [])].sort() });
            return true;
          }
          if (url.pathname === "/auth/admin/report-done") {
            if (d.pool) await d.pool.query("UPDATE chat_reports SET handled_at = now() WHERE id = $1", [str(b.id)]);
            else d.memoryReports?.splice(Number(str(b.id)), 1);
            send(200, { ok: true });
            return true;
          }
          if (url.pathname === "/auth/admin/mute") {
            const target = (await accounts.find(str(b.target)))?.id;
            if (!target) throw new AccountError("UNKNOWN_PLAYER", 404);
            const muted = b.muted === true;
            if (d.pool) await d.pool.query(`UPDATE users SET chat_muted_at = ${muted ? "now()" : "NULL"} WHERE id = $1`, [target]);
            if (muted) d.chatMuted?.add(target); else d.chatMuted?.delete(target);
            send(200, { ok: true, userId: target, muted });
            return true;
          }
          // ─── retransmissions (DGT / LiveChessCloud) ───
          if (url.pathname === "/auth/admin/relays") {
            send(200, { relays: d.relays?.list() ?? [] });
            return true;
          }
          if (url.pathname === "/auth/admin/relay-add") {
            if (!d.relays || !d.parseRelaySource) throw new HttpError(503, "UNAVAILABLE");
            const ref = d.parseRelaySource(str(b.url));
            if (!ref) throw new HttpError(400, "BAD_URL");
            const round = Number.isInteger(b.round) && (b.round as number) >= 0 && (b.round as number) < 1000 ? (b.round as number) : ref.round;
            const name = str(b.name).trim().slice(0, 80) || "Retransmission";
            const rec = await d.relays.add({ name, source: ref.source, lccId: ref.id, round, createdBy: str(b.by) || "organisateur" });
            send(200, { ok: true, relay: rec });
            return true;
          }
          if (url.pathname === "/auth/admin/relay-remove") {
            if (!d.relays) throw new HttpError(503, "UNAVAILABLE");
            send(200, { ok: await d.relays.remove(str(b.id)) });
            return true;
          }
          // ─── anti-triche : parties à revoir, revue, suspension ───
          if (url.pathname === "/auth/admin/fairplay") {
            if (d.pool) {
              const r = await d.pool.query<{
                game_id: string; user_id: string; reasons: string[]; focus_losses: number; time_cv: number | null; moves: number; created_at: Date;
                white_id: string; black_id: string; result: string; time_control: string; reports: string[] | null;
              }>(
                `SELECT s.game_id, s.user_id, s.reasons, s.focus_losses, s.time_cv, s.moves, s.created_at,
                        g.white_id, g.black_id, g.result, g.time_control,
                        (SELECT array_agg(r.reporter_id || ' : ' || coalesce(nullif(r.reason, ''), '(sans précision)'))
                           FROM cheat_reports r WHERE r.game_id = s.game_id AND r.reported_id = s.user_id AND r.reviewed_at IS NULL) AS reports
                   FROM cheat_signals s JOIN games g ON g.id::text = s.game_id
                  WHERE s.reviewed_at IS NULL
                    AND (s.flagged OR EXISTS (SELECT 1 FROM cheat_reports r WHERE r.game_id = s.game_id AND r.reported_id = s.user_id AND r.reviewed_at IS NULL))
                  ORDER BY s.created_at DESC LIMIT 100`);
              const sus = await d.pool.query<{ id: string }>("SELECT id FROM users WHERE state = 'suspended' ORDER BY id LIMIT 200");
              send(200, {
                cases: r.rows.map((x) => ({
                  gameId: x.game_id, userId: x.user_id, reasons: x.reasons, focusLosses: x.focus_losses, timeCv: x.time_cv, moves: x.moves,
                  at: x.created_at.toISOString(), white: x.white_id, black: x.black_id, result: x.result, timeControl: x.time_control, reports: x.reports ?? [],
                })),
                suspended: sus.rows.map((x) => x.id),
              });
            } else {
              const m = d.fairplayMem ?? { signals: [], reports: [] };
              const reportsOf = (gameId: string, userId: string) => m.reports.filter((r) => !r.reviewed && r.gameId === gameId && r.reported === userId).map((r) => `${r.reporter} : ${r.reason || "(sans précision)"}`);
              send(200, {
                cases: m.signals.filter((x) => !x.reviewed && (x.flagged || reportsOf(x.gameId, x.userId).length > 0))
                  .map((x) => ({ ...x, reports: reportsOf(x.gameId, x.userId) })).reverse().slice(0, 100),
                suspended: [],
              });
            }
            return true;
          }
          if (url.pathname === "/auth/admin/game") {
            const gameId = str(b.gameId);
            const g = d.repo ? await d.repo.getGamePublic(gameId, "") : null;
            if (!g) throw new HttpError(404, "NOT_FOUND");
            send(200, g);
            return true;
          }
          if (url.pathname === "/auth/admin/fairplay-review") {
            const gameId = str(b.gameId), userId = str(b.userId), verdict = str(b.verdict);
            if (verdict !== "clean" && verdict !== "cheat") throw new HttpError(400, "BAD_VERDICT");
            if (d.pool) {
              await d.pool.query("UPDATE cheat_signals SET reviewed_at = now(), verdict = $3 WHERE game_id = $1 AND user_id = $2", [gameId, userId, verdict]);
              await d.pool.query("UPDATE cheat_reports SET reviewed_at = now() WHERE game_id = $1 AND reported_id = $2", [gameId, userId]);
              if (verdict === "cheat") await d.pool.query("UPDATE users SET state = 'suspended' WHERE id = $1 AND state IN ('active', 'withdrawal_hold')", [userId]);
            } else if (d.fairplayMem) {
              for (const x of d.fairplayMem.signals) if (x.gameId === gameId && x.userId === userId) x.reviewed = true;
              for (const x of d.fairplayMem.reports) if (x.gameId === gameId && x.reported === userId) x.reviewed = true;
            }
            if (verdict === "cheat") d.kickUser?.(userId);
            send(200, { ok: true });
            return true;
          }
          if (url.pathname === "/auth/admin/suspend") {
            const target = (await accounts.find(str(b.target)))?.id;
            if (!target) throw new AccountError("UNKNOWN_PLAYER", 404);
            const suspended = b.suspended === true;
            if (d.pool) {
              await d.pool.query(suspended
                ? "UPDATE users SET state = 'suspended' WHERE id = $1 AND state IN ('active', 'withdrawal_hold')"
                : "UPDATE users SET state = 'active' WHERE id = $1 AND state = 'suspended'", [target]);
            }
            if (suspended) d.kickUser?.(target);
            send(200, { ok: true, userId: target, suspended });
            return true;
          }
          throw new HttpError(404, "NOT_FOUND");
        }
        if (url.pathname !== "/auth/signup" && url.pathname !== "/auth/login") throw new HttpError(404, "NOT_FOUND");
        const u = url.pathname === "/auth/signup"
          ? await accounts.signup({
              pseudo: str(b.pseudo), password: str(b.password), flag: str(b.flag) || null, email: str(b.email) || null,
              adult: b.adult === true, terms: b.terms === true, betaCodeOk: b.betaCodeOk === true, clientIp,
            })
          : await accounts.login({ pseudo: str(b.pseudo), password: str(b.password), clientIp });
        send(200, u);
      } catch (e) {
        if (e instanceof AccountError) { send(e.status, { error: e.code }); return true; }
        throw e;
      }
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

    // ─── Compte joueur : historique des parties ──────────────────────────────────
    if (url.pathname === "/account/games" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 30);
      const before = url.searchParams.get("before");
      if (before !== null && Number.isNaN(Date.parse(before))) throw new HttpError(400, "BAD_CURSOR");
      send(200, { games: await need(d.repo).listGames(claims.sub, Number.isFinite(limit) ? limit : 30, before ?? undefined) });
      return true;
    }
    const pub = url.pathname.match(/^\/account\/games\/([0-9a-f-]{36})\/public$/i);
    if (pub && req.method === "GET") {
      const g = await need(d.repo).getGamePublic(pub[1]!, claims.sub);
      if (!g) throw new HttpError(404, "NOT_FOUND");
      send(200, g);
      return true;
    }
    const gm = url.pathname.match(/^\/account\/games\/([0-9a-f-]{36})$/i);
    if (gm && req.method === "GET") {
      const g = await need(d.repo).getGame(claims.sub, gm[1]!);
      if (!g) throw new HttpError(404, "NOT_FOUND");
      send(200, g);
      return true;
    }

    // ─── Profils et classement (joueurs connectés) ───────────────────────────────
    const pgm = url.pathname.match(/^\/account\/players\/([^/]{1,200})\/games$/);
    if (pgm && req.method === "GET") {
      let pseudo: string;
      try { pseudo = decodeURIComponent(pgm[1]!); } catch { throw new HttpError(400, "BAD_PSEUDO"); }
      const before = url.searchParams.get("before");
      if (before !== null && Number.isNaN(Date.parse(before))) throw new HttpError(400, "BAD_CURSOR");
      const repo = need(d.repo);
      const p = await repo.getProfile(pseudo);
      if (!p) throw new HttpError(404, "NOT_FOUND");
      send(200, { games: await repo.listGames(p.userId, 30, before ?? undefined) });
      return true;
    }
    if (url.pathname === "/account/games/export" && req.method === "GET") {
      const pgns = await need(d.repo).exportPgns(claims.sub, 20_000);
      res.writeHead(200, { "content-type": "application/x-chess-pgn; charset=utf-8", "cache-control": "no-store" });
      res.end(pgns.map((x) => x.trim()).join("\n\n") + "\n");
      return true;
    }
    const pm = url.pathname.match(/^\/account\/players\/([^/]{1,200})$/);
    if (pm && req.method === "GET") {
      let pseudo: string;
      try { pseudo = decodeURIComponent(pm[1]!); } catch { throw new HttpError(400, "BAD_PSEUDO"); }
      const p = await need(d.repo).getProfile(pseudo);
      if (!p) throw new HttpError(404, "NOT_FOUND");
      send(200, { ...p, liveGameId: d.liveGameOf?.(p.userId) ?? null });
      return true;
    }
    // ─── Amis : liste personnelle avec présence (en ligne, en partie) ─────────────
    // analyse pédagogique calculée dans un navigateur : partagée avec tous (trop grosse pour le websocket, borné à 16 Ko)
    if (url.pathname === "/account/relay-review" && req.method === "POST") {
      if (!d.relays || !d.reviews) throw new HttpError(503, "UNAVAILABLE");
      const b = await body(req, REVIEW_MAX_BYTES + 4096);
      const relayId = typeof b.relayId === "string" ? b.relayId : "";
      const round = typeof b.round === "number" ? b.round : -1;
      const index = typeof b.index === "number" ? b.index : -1;
      const sans = Array.isArray(b.sans) ? (b.sans as unknown[]) : null;
      if (!relayId || !sans) throw new HttpError(400, "BAD_PAYLOAD");
      // seulement une partie terminée, connue du serveur, avec exactement les mêmes coups
      const g = d.relays.findGame(relayId, round, index);
      if (!g || g.result === null) throw new HttpError(404, "UNKNOWN_GAME");
      if (g.sans.length !== sans.length || g.sans.some((x, i) => x !== sans[i])) throw new HttpError(409, "MOVES_MISMATCH");
      if (!validReview(b.review, g.sans)) throw new HttpError(400, "BAD_REVIEW");
      const saved = await d.reviews.putIfAbsent(reviewStoreKey(relayId, round, index, g.sans.length), b.review, claims.sub);
      send(200, { ok: true, saved });
      return true;
    }
    if (url.pathname === "/account/relays" && req.method === "GET") {
      send(200, { relays: d.relays?.list() ?? [] });
      return true;
    }
    if (url.pathname === "/account/friends" && req.method === "GET") {
      const list = await need(d.repo).listFriends(claims.sub);
      send(200, { friends: list.map((f) => ({ ...f, online: d.isOnline?.(f.userId) ?? false, liveGameId: d.liveGameOf?.(f.userId) ?? null })) });
      return true;
    }
    if (url.pathname === "/account/friends" && req.method === "POST") {
      const b = await body(req);
      const pseudo = typeof b.pseudo === "string" ? b.pseudo.trim() : "";
      if (!pseudo || pseudo.length > 40) throw new HttpError(400, "BAD_PSEUDO");
      const acc = await need(d.accounts).find(pseudo);
      if (!acc || acc.state === "suspended" || acc.state === "closed") throw new HttpError(404, "NOT_FOUND");
      if (acc.id === claims.sub) throw new HttpError(400, "SELF");
      if ((await need(d.repo).addFriend(claims.sub, acc.id)) === "full") throw new HttpError(409, "TOO_MANY_FRIENDS");
      send(200, { ok: true, userId: acc.id });
      return true;
    }
    const fm = url.pathname.match(/^\/account\/friends\/([^/]{1,200})$/);
    if (fm && req.method === "DELETE") {
      let id: string;
      try { id = decodeURIComponent(fm[1]!); } catch { throw new HttpError(400, "BAD_PSEUDO"); }
      await need(d.repo).removeFriend(claims.sub, id);
      send(200, { ok: true });
      return true;
    }
    if (url.pathname === "/account/leaderboard" && req.method === "GET") {
      const tc = url.searchParams.get("tc") ?? "blitz_3_0";
      if (!(tc in TIME_CONTROLS)) throw new HttpError(400, "BAD_TIME_CONTROL");
      const r = await need(d.repo).leaderboard(tc as TimeControlId, 100, claims.sub);
      send(200, { timeControl: tc, ...r });
      return true;
    }

    // ─── Compte joueur : répertoire d'ouvertures et exercices ───────────────────
    // ─── Réglages du joueur (apparence, son), synchronisés entre ses appareils ──────
    if (url.pathname === "/account/settings" && req.method === "GET") {
      send(200, { data: await need(d.repo).getSettings(claims.sub) });
      return true;
    }
    if (url.pathname === "/account/settings" && req.method === "PUT") {
      const b = await body(req, SETTINGS_MAX_BYTES + 512);
      if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) throw new HttpError(400, "BAD_PAYLOAD");
      if (Buffer.byteLength(JSON.stringify(b.data)) > SETTINGS_MAX_BYTES) throw new HttpError(413, "TOO_LARGE");
      await need(d.repo).saveSettings(claims.sub, b.data);
      send(200, { ok: true });
      return true;
    }
    if (url.pathname === "/account/repertoire" && req.method === "GET") {
      const repo = need(d.repo);
      const [games, saved] = await Promise.all([repo.listRepertoireGames(claims.sub, 500), repo.getRepertoire(claims.sub)]);
      send(200, { games, data: saved?.data ?? null, updatedAt: saved?.updatedAt ?? null });
      return true;
    }
    if (url.pathname === "/account/repertoire" && req.method === "PUT") {
      const b = await body(req, REPERTOIRE_MAX_BYTES + 1024);
      if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) throw new HttpError(400, "BAD_PAYLOAD");
      if (Buffer.byteLength(JSON.stringify(b.data)) > REPERTOIRE_MAX_BYTES) throw new HttpError(413, "TOO_LARGE");
      send(200, await need(d.repo).saveRepertoire(claims.sub, b.data));
      return true;
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
