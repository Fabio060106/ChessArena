/**
 * Géo-filtrage et kill-switch argent réel.
 *
 * Toute connexion (WebSocket ou HTTP) reçoit un MODE DE SESSION :
 *
 *   REAL_MONEY       — kill-switch ON  ∧ REAL_MONEY_ENABLED=1
 *                      ∧ pays de l'IP ∈ pays autorisés ∧ pays de résidence (KYC) ∈ pays autorisés
 *   PLAY_MONEY_ONLY  — dans tous les autres cas (fail closed : IP inconnue = pas d'argent réel)
 *   LOCKED           — joueur auto-exclu : aucun jeu, consultation et retraits seulement
 *
 * Pays autorisés effectifs = liste en base (pilotée par la conformité, à chaud)
 *                            ∩ liste d'environnement (plafond fixé au déploiement).
 * Aucune des deux ne peut donc à elle seule ouvrir un pays : un back-office compromis ne
 * peut pas étendre l'argent réel au-delà de ce que le déploiement autorise.
 *
 * Anti-usurpation (OWASP — « IP spoofing via X-Forwarded-For ») : les en-têtes
 * X-Forwarded-For et pays-edge ne sont lus QUE si la connexion TCP provient d'un proxy
 * de confiance déclaré ; sinon l'adresse TCP fait foi. Dans X-Forwarded-For, on retient la
 * première adresse NON fiable en partant de la droite (les entrées de gauche sont écrites
 * par le client et ne prouvent rien).
 *
 * Les retraits ne sont jamais soumis au géo-filtrage : un joueur doit pouvoir récupérer
 * son solde depuis n'importe où (le KYC et les garde-fous comptables s'appliquent toujours).
 */
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type pg from "pg";
import type { SessionMode, SessionModeEvent, SessionModeReason } from "@chessarena/shared";
import type { AuditSink } from "../audit/auditLog.js";

// ═════════════════════════════════════════════════════════════════════════════
// Adresses IP
// ═════════════════════════════════════════════════════════════════════════════
export interface ParsedIp { v: 4 | 6; n: bigint }

/** Normalise IPv4, IPv6 et IPv4-mappée (::ffff:a.b.c.d → IPv4). null si invalide. */
export function parseIp(raw: string): ParsedIp | null {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]")); // [v6]:port
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ip.split(".").reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n);
    return { v: 4, n };
  }
  if (kind === 6) {
    const [head, tail] = ip.includes("::") ? ip.split("::") as [string, string] : [ip, null];
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    // suffixe IPv4 éventuel (ex. 64:ff9b::1.2.3.4)
    const expand = (parts: string[]) => parts.flatMap((p) => {
      if (!p.includes(".")) return [p];
      const v4 = parseIp(p);
      if (!v4 || v4.v !== 4) return ["x"];
      return [((v4.n >> 16n) & 0xffffn).toString(16), (v4.n & 0xffffn).toString(16)];
    });
    const H = expand(h), T = expand(t);
    const groups = tail === null ? H : [...H, ...Array(8 - H.length - T.length).fill("0"), ...T];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    return { v: 6, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n) };
  }
  return null;
}

export interface Cidr { v: 4 | 6; start: bigint; end: bigint }

export function parseCidr(raw: string): Cidr | null {
  const [addr, lenRaw] = raw.trim().split("/");
  const ip = parseIp(addr ?? "");
  if (!ip) return null;
  const bits = ip.v === 4 ? 32 : 128;
  const len = lenRaw === undefined ? bits : Number(lenRaw);
  if (!Number.isInteger(len) || len < 0 || len > bits) return null;
  const host = (1n << BigInt(bits - len)) - 1n;
  const start = ip.n & ~host & ((1n << BigInt(bits)) - 1n);
  return { v: ip.v, start, end: start | host };
}

export class CidrSet {
  private readonly list: Cidr[];
  constructor(cidrs: readonly string[]) {
    this.list = cidrs.map((c) => {
      const p = parseCidr(c);
      if (!p) throw new Error(`CIDR invalide : ${c}`);
      return p;
    });
  }
  has(ip: string): boolean {
    const p = parseIp(ip);
    return !!p && this.list.some((c) => c.v === p.v && p.n >= c.start && p.n <= c.end);
  }
  get size(): number { return this.list.length; }
}

// ═════════════════════════════════════════════════════════════════════════════
// Résolution IP → pays
// ═════════════════════════════════════════════════════════════════════════════
export interface GeoResolver {
  /** ISO-3166 alpha-2 en majuscules, ou null si inconnu. */
  lookup(ip: string): string | null;
}

/**
 * Base CIDR → pays chargée en mémoire, recherche dichotomique (O(log n)).
 * Format accepté : CSV `network,country_iso_code` (un bloc par ligne, en-tête facultatif),
 * soit l'export « GeoLite2-Country-Blocks » joint aux codes pays. ~400 k blocs ≈ 40 Mo.
 */
export class CidrGeoResolver implements GeoResolver {
  private readonly v4: Array<[bigint, bigint, string]> = [];
  private readonly v6: Array<[bigint, bigint, string]> = [];

  constructor(entries: Iterable<[string, string]>) {
    for (const [net, cc] of entries) {
      const c = parseCidr(net);
      if (!c || !/^[A-Z]{2}$/.test(cc)) continue;
      (c.v === 4 ? this.v4 : this.v6).push([c.start, c.end, cc]);
    }
    const cmp = (a: [bigint, bigint, string], b: [bigint, bigint, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    this.v4.sort(cmp);
    this.v6.sort(cmp);
  }

  static fromCsv(text: string): CidrGeoResolver {
    const rows: Array<[string, string]> = [];
    for (const line of text.split(/\r?\n/)) {
      const [net, cc] = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      if (net && cc && net.includes("/")) rows.push([net, cc.toUpperCase()]);
    }
    return new CidrGeoResolver(rows);
  }

  static async fromFile(path: string): Promise<CidrGeoResolver> {
    return CidrGeoResolver.fromCsv(await readFile(path, "utf8"));
  }

  get size(): number { return this.v4.length + this.v6.length; }

  lookup(ip: string): string | null {
    const p = parseIp(ip);
    if (!p) return null;
    const t = p.v === 4 ? this.v4 : this.v6;
    let lo = 0, hi = t.length - 1, best = -1;
    while (lo <= hi) {                       // dernier bloc dont le début ≤ ip
      const mid = (lo + hi) >> 1;
      if (t[mid]![0] <= p.n) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 && p.n <= t[best]![1] ? t[best]![2] : null;
  }
}

/** Résolveur nul : tout est inconnu → PLAY_MONEY_ONLY (fail closed). */
export const unknownGeoResolver: GeoResolver = { lookup: () => null };

// ═════════════════════════════════════════════════════════════════════════════
// Origine du client (anti-usurpation)
// ═════════════════════════════════════════════════════════════════════════════
export interface ClientOrigin {
  /** adresse retenue comme celle du client */
  ip: string;
  /** pays retenu (null = inconnu) */
  country: string | null;
  /** d'où vient le pays retenu (journalisation / débogage) */
  source: "edge-header" | "geo-db" | "none";
}

export interface OriginOptions {
  trustedProxies: CidrSet;
  resolver: GeoResolver;
  /** en-tête pays posé par l'edge (CDN / LB), ex. "cf-ipcountry". Vide = ignoré. */
  edgeCountryHeader: string;
}

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v.join(",") : v;
};

export function clientOrigin(remoteAddress: string | undefined, headers: Headers, o: OriginOptions): ClientOrigin {
  const remote = remoteAddress ?? "";
  let ip = remote;
  let viaTrusted = false;
  if (remote && o.trustedProxies.has(remote)) {
    viaTrusted = true;
    const xff = (header(headers, "x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // de droite à gauche : la première adresse qui n'est pas un de nos proxys est le client
    for (let i = xff.length - 1; i >= 0; i--) {
      const hop = xff[i]!;
      if (!parseIp(hop)) break;              // entrée mal formée : on s'arrête au dernier saut sûr
      ip = hop;
      if (!o.trustedProxies.has(hop)) break;
    }
  }
  if (viaTrusted && o.edgeCountryHeader) {
    const cc = (header(headers, o.edgeCountryHeader) ?? "").trim().toUpperCase();
    // XX = inconnu, T1 = Tor (Cloudflare), A1/A2 = proxy anonyme / satellite : inconnu
    if (/^[A-Z]{2}$/.test(cc) && !["XX", "T1", "A1", "A2"].includes(cc)) return { ip, country: cc, source: "edge-header" };
  }
  const cc = o.resolver.lookup(ip);
  return { ip, country: cc, source: cc ? "geo-db" : "none" };
}

// ═════════════════════════════════════════════════════════════════════════════
// Décision de mode (fonction pure)
// ═════════════════════════════════════════════════════════════════════════════
export interface SessionModeInput {
  killSwitch: { enabled: boolean; countries: readonly string[] };
  ipCountry: string | null;
  /** pays de résidence vérifié par le KYC ; null si pas encore vérifié */
  residenceCountry: string | null;
  selfExcluded: boolean;
}

export function decideSessionMode(i: SessionModeInput): SessionModeEvent {
  const r = (mode: SessionMode, reason: SessionModeReason): SessionModeEvent => ({ mode, reason });
  if (i.selfExcluded) return r("LOCKED", "SELF_EXCLUDED");
  if (!i.killSwitch.enabled) return r("PLAY_MONEY_ONLY", "REAL_MONEY_DISABLED");
  if (!i.ipCountry) return r("PLAY_MONEY_ONLY", "UNKNOWN_LOCATION");
  if (!i.killSwitch.countries.includes(i.ipCountry)) return r("PLAY_MONEY_ONLY", "JURISDICTION_BLOCKED");
  // résidence inconnue (KYC non fait) : on n'empêche pas l'accès au mode — c'est le KYC qui
  // bloque ensuite dépôts et mises — mais une résidence connue hors liste ferme l'argent réel
  if (i.residenceCountry && !i.killSwitch.countries.includes(i.residenceCountry)) return r("PLAY_MONEY_ONLY", "RESIDENCE_BLOCKED");
  return r("REAL_MONEY", "OK");
}

// ═════════════════════════════════════════════════════════════════════════════
// Kill-switch (état persistant, partagé entre instances)
// ═════════════════════════════════════════════════════════════════════════════
export interface KillSwitchState {
  /** effectif : base ∧ environnement */
  enabled: boolean;
  /** effectifs : base ∩ environnement */
  countries: string[];
  db: { enabled: boolean; countries: string[]; updatedBy: string; updatedAt: string };
  env: { enabled: boolean; countries: string[] };
}

export interface KillSwitchOptions {
  envEnabled: boolean;
  envCountries: readonly string[];
  /** durée de cache de la lecture en base (ms) — borne la latence de propagation inter-instances */
  cacheMs?: number;
  now?: () => number;
}

type Listener = (s: KillSwitchState, previous: KillSwitchState | null) => void | Promise<void>;

/**
 * Interrupteur global de l'argent réel. Source de vérité : `compliance_settings.real_money`.
 * Chaque bascule est journalisée (table immuable `compliance_events` + chaîne d'audit).
 * Sans base (dev / test de charge), état mémoire initialisé depuis l'environnement.
 */
export class KillSwitch {
  private cached: { s: KillSwitchState; at: number } | null = null;
  private last: KillSwitchState | null = null;
  private readonly listeners: Listener[] = [];
  private memory: KillSwitchState["db"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly pool: pg.Pool | null, private readonly audit: AuditSink | undefined, private readonly o: KillSwitchOptions) {
    this.now = o.now ?? Date.now;
    this.memory = { enabled: o.envEnabled, countries: [...o.envCountries], updatedBy: "env", updatedAt: new Date(this.now()).toISOString() };
  }

  private compose(db: KillSwitchState["db"]): KillSwitchState {
    const envC = this.o.envCountries.map((c) => c.toUpperCase());
    return {
      enabled: db.enabled && this.o.envEnabled,
      countries: db.countries.map((c) => c.toUpperCase()).filter((c) => envC.includes(c)).sort(),
      db,
      env: { enabled: this.o.envEnabled, countries: [...envC] },
    };
  }

  private async readDb(): Promise<KillSwitchState["db"]> {
    if (!this.pool) return this.memory;
    const r = await this.pool.query<{ value: { enabled?: unknown; countries?: unknown }; updated_by: string; updated_at: Date }>(
      "SELECT value, updated_by, updated_at FROM compliance_settings WHERE key = 'real_money'",
    );
    const row = r.rows[0];
    // ligne absente ou corrompue : fermé (fail closed)
    if (!row) return { enabled: false, countries: [], updatedBy: "missing", updatedAt: new Date(0).toISOString() };
    const countries = Array.isArray(row.value.countries) ? row.value.countries.filter((c): c is string => typeof c === "string" && /^[A-Za-z]{2}$/.test(c)) : [];
    return { enabled: row.value.enabled === true, countries, updatedBy: row.updated_by, updatedAt: row.updated_at.toISOString() };
  }

  /** État courant (cache court). Toute erreur de lecture → fermé. */
  async state(): Promise<KillSwitchState> {
    if (this.cached && this.now() - this.cached.at < (this.o.cacheMs ?? 2_000)) return this.cached.s;
    let s: KillSwitchState;
    try {
      s = this.compose(await this.readDb());
    } catch (e) {
      console.error("[kill-switch] lecture impossible, argent réel coupé", (e as Error).message);
      s = this.compose({ enabled: false, countries: [], updatedBy: "read_error", updatedAt: new Date(this.now()).toISOString() });
    }
    this.cached = { s, at: this.now() };
    await this.detectChange(s);
    return s;
  }

  /** Dernier état connu sans E/S (null tant qu'aucune lecture). */
  peek(): KillSwitchState | null { return this.cached?.s ?? null; }

  onChange(l: Listener): void { this.listeners.push(l); }

  private async detectChange(s: KillSwitchState): Promise<void> {
    const prev = this.last;
    this.last = s;
    const key = (x: KillSwitchState | null) => (x ? `${x.enabled}|${x.countries.join(",")}` : "");
    if (prev && key(prev) !== key(s)) {
      for (const l of this.listeners) {
        try { await l(s, prev); } catch (e) { console.error("[kill-switch] listener en erreur", e); }
      }
    }
  }

  /**
   * Bascule par un agent conformité. `countries` omis = inchangé.
   * Écriture + événement immuable dans la même transaction ; audit chaîné ensuite.
   */
  async set(actor: string, change: { enabled: boolean; countries?: string[] }, reason: string): Promise<KillSwitchState> {
    if (!reason || reason.trim().length < 5) throw new Error("motif obligatoire (≥ 5 caractères)");
    const countries = change.countries?.map((c) => c.trim().toUpperCase());
    if (countries?.some((c) => !/^[A-Z]{2}$/.test(c))) throw new Error("codes pays ISO-3166 alpha-2 attendus");
    let before: KillSwitchState["db"];
    let after: KillSwitchState["db"];
    if (this.pool) {
      const c = await this.pool.connect();
      try {
        await c.query("BEGIN");
        const cur = await c.query<{ value: { enabled: boolean; countries: string[] } }>(
          "SELECT value FROM compliance_settings WHERE key = 'real_money' FOR UPDATE",
        );
        const prevV = cur.rows[0]?.value ?? { enabled: false, countries: [] };
        before = { enabled: prevV.enabled === true, countries: prevV.countries ?? [], updatedBy: "", updatedAt: "" };
        const value = { enabled: change.enabled, countries: countries ?? before.countries };
        const w = await c.query<{ updated_at: Date }>(
          `INSERT INTO compliance_settings (key, value, updated_by, updated_at) VALUES ('real_money', $1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING updated_at`,
          [JSON.stringify(value), actor],
        );
        await c.query(
          "INSERT INTO compliance_events (event, actor, details) VALUES ($1, $2, $3)",
          [change.enabled ? "real_money_enabled" : "real_money_disabled", actor, JSON.stringify({ before: { enabled: before.enabled, countries: before.countries }, after: value, reason })],
        );
        await c.query("COMMIT");
        after = { ...value, updatedBy: actor, updatedAt: w.rows[0]!.updated_at.toISOString() };
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    } else {
      before = this.memory;
      after = { enabled: change.enabled, countries: countries ?? this.memory.countries, updatedBy: actor, updatedAt: new Date(this.now()).toISOString() };
      this.memory = after;
    }
    this.audit?.append("compliance.killswitch", {
      actor, reason, before: { enabled: before.enabled, countries: before.countries }, after: { enabled: after.enabled, countries: after.countries },
    });
    this.cached = null;                       // propagation immédiate sur cette instance
    return this.state();
  }

  /** Surveille la base pour propager les bascules faites depuis une autre instance. */
  watch(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.cached = null; void this.state(); }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Façade : origine + kill-switch → mode de session
// ═════════════════════════════════════════════════════════════════════════════
export class GeoFilter {
  constructor(readonly killSwitch: KillSwitch, private readonly origin: OriginOptions) {}

  originOf(remoteAddress: string | undefined, headers: Headers): ClientOrigin {
    return clientOrigin(remoteAddress, headers, this.origin);
  }

  async modeFor(ipCountry: string | null, residenceCountry: string | null, selfExcluded: boolean): Promise<SessionModeEvent> {
    const ks = await this.killSwitch.state();
    return decideSessionMode({ killSwitch: ks, ipCountry, residenceCountry, selfExcluded });
  }
}
