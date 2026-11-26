import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { RelayGameView, RelayRoundRef, RelayRoundView, RelaySummary } from "@chessarena/shared";
import {
  lccGameView, lccUrls, LCC_POOL, normResult, roundCandidates,
  type LccGame, type LccRound, type LccTournament,
} from "./lcc.js";
import { decodeLichess, LICHESS, lichessPgnGames, pickLichessRound, type LichessRoundInfo, type LichessTour } from "./lichess.js";

/** Retransmission enregistrée (organisateur). */
export interface RelayRecord {
  id: string; name: string;
  /** source : échiquiers DGT (LiveChessCloud, par défaut) ou Lichess Broadcast (secours) */
  source?: "lcc" | "lichess";
  /** identifiant à la source : uuid LiveChessCloud, ou « tour:… » / « round:… » pour Lichess */
  lccId: string;
  round: number; createdBy: string; createdAt: string;
}

export interface RelayStore {
  list(): Promise<RelayRecord[]>;
  add(r: RelayRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export class InMemoryRelayStore implements RelayStore {
  private readonly rows = new Map<string, RelayRecord>();
  async list() { return [...this.rows.values()]; }
  async add(r: RelayRecord) { this.rows.set(r.id, r); }
  async remove(id: string) { this.rows.delete(id); }
}

export class PgRelayStore implements RelayStore {
  constructor(private readonly pool: pg.Pool) {}
  async list(): Promise<RelayRecord[]> {
    const r = await this.pool.query<{ id: string; name: string; source: string; lcc_id: string; round: number; created_by: string; created_at: Date }>(
      "SELECT id, name, source, lcc_id, round, created_by, created_at FROM relays ORDER BY created_at DESC");
    return r.rows.map((x) => ({ id: x.id, name: x.name, source: x.source === "lichess" ? "lichess" : "lcc", lccId: x.lcc_id, round: x.round, createdBy: x.created_by, createdAt: x.created_at.toISOString() }));
  }
  async add(r: RelayRecord) {
    await this.pool.query("INSERT INTO relays (id, name, source, lcc_id, round, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [r.id, r.name, r.source ?? "lcc", r.lccId, r.round, r.createdBy]);
  }
  async remove(id: string) { await this.pool.query("DELETE FROM relays WHERE id = $1", [id]); }
}

export type FetchJson = (url: string) => Promise<unknown | null>;
export type FetchText = (url: string) => Promise<string | null>;

const UA = { "user-agent": "ChessAurum relay (+https://chess-arena-97af.vercel.app)" };

/** GET texte (PGN) ; 404 → null ; 429 (trop de requêtes) → exception reconnue, on ralentit. */
export function httpFetchText(timeoutMs = 10_000): FetchText {
  return async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: UA });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };
}

/** GET JSON avec délai maximal ; 404 → null (partie pas encore créée), autre erreur → exception. */
export function httpFetchJson(timeoutMs = 8_000): FetchJson {
  return async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: UA });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
}

/** intervalle minimal entre deux lectures du JSON d'un tournoi Lichess */
export const LICHESS_TOUR_EVERY = 45_000;
/** … quand une ronde est sur le point de commencer */
export const LICHESS_TOUR_SOON = 15_000;

interface Live {
  rec: RelayRecord;
  tournamentName: string | null;
  currentRound: number | null;
  roundName: string | null;
  /** Lichess : tournoi retrouvé à partir d'un lien de ronde (on suit alors tout le tournoi) */
  lichessTour?: string;
  /** Lichess : ronde choisie lors de la dernière lecture du tournoi, et sa date (l'API JSON est limitée à 10 lectures/min) */
  lichessPick?: { id: string; number: number; name: string | null; soon: boolean; at: number } | null;
  /** source qui demande de ralentir (HTTP 429) : pause jusqu'à cette date */
  pausedUntil: number;
  games: Map<number, { view: RelayGameView; key: string }>;
  /** toutes les rondes connues (identifiant Lichess de chaque ronde le cas échéant) */
  rounds: Array<RelayRoundRef & { lichessId?: string }>;
  /** rondes déjà jouées, lues à la demande (gardées : une partie finie ne change plus) */
  past: Map<number, { view: RelayRoundView; at: number; final: boolean }>;
  updatedAt: number | null;
  error: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  polls: number;
  busy: boolean;
}

export interface RelayOptions {
  store: RelayStore;
  fetchJson?: FetchJson;
  fetchText?: FetchText;
  /** adresse de Lichess (tests : faux serveur) */
  lichess?: string;
  pool?: string;
  /** spectateurs d'une retransmission (rythme de rafraîchissement) */
  watchers: (relayId: string) => number;
  onRound: (r: RelayRoundView) => void;
  onGame: (relayId: string, round: number, g: RelayGameView) => void;
  /** rythme : avec spectateurs / sans / tout est fini */
  intervals?: { watched: number; idle: number; finished: number };
  now?: () => number;
  /** false = pas de minuterie (tests : poll() à la main) */
  autoStart?: boolean;
}

/**
 * Retransmissions DGT / LiveChessCloud : une seule lecture de la source par retransmission,
 * quel que soit le nombre de spectateurs ; seules les parties qui changent sont renvoyées.
 */
export class RelayService {
  private readonly live = new Map<string, Live>();
  private readonly fetchJson: FetchJson;
  private readonly fetchText: FetchText;
  private readonly iv: { watched: number; idle: number; finished: number };
  private readonly now: () => number;
  private closed = false;
  /** Lichess n'accepte qu'un téléchargement de PGN à la fois par adresse IP (sans compte) : on les enchaîne */
  private lichessChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: RelayOptions) {
    this.fetchJson = o.fetchJson ?? httpFetchJson();
    this.fetchText = o.fetchText ?? httpFetchText();
    this.iv = o.intervals ?? { watched: 3_000, idle: 30_000, finished: 60_000 };
    this.now = o.now ?? Date.now;
  }

  async start(): Promise<void> {
    for (const rec of await this.o.store.list()) this.attach(rec);
  }

  /**
   * Ajoute une retransmission par défaut si aucune retransmission de la même source n'existe déjà
   * (ex. le Championnat du monde), pour qu'elle apparaisse sans réglage manuel.
   */
  async seed(input: { name: string; source: "lcc" | "lichess"; lccId: string; round: number }): Promise<RelayRecord | null> {
    if ([...this.live.values()].some((l) => (l.rec.source ?? "lcc") === input.source)) return null;
    return this.add({ ...input, createdBy: "auto" });
  }

  async add(input: { name: string; source?: "lcc" | "lichess"; lccId: string; round: number; createdBy: string }): Promise<RelayRecord> {
    const rec: RelayRecord = { id: randomBytes(4).toString("hex"), createdAt: new Date(this.now()).toISOString(), ...input };
    await this.o.store.add(rec);
    this.attach(rec);
    return rec;
  }

  async remove(id: string): Promise<boolean> {
    const l = this.live.get(id);
    if (!l) return false;
    if (l.timer) clearTimeout(l.timer);
    this.live.delete(id);
    await this.o.store.remove(id);
    return true;
  }

  list(): RelaySummary[] {
    return [...this.live.values()].sort((a, b) => b.rec.createdAt.localeCompare(a.rec.createdAt)).map((l) => this.summary(l));
  }

  view(id: string): RelayRoundView | null {
    const l = this.live.get(id);
    if (!l) return null;
    return { ...this.summary(l), tournamentName: l.tournamentName, gameList: [...l.games.values()].map((g) => g.view).sort((a, b) => a.index - b.index) };
  }

  /** Un spectateur arrive : on rafraîchit tout de suite si les données ont plus de quelques secondes. */
  wake(id: string): void {
    const l = this.live.get(id);
    if (!l || l.busy) return;
    if (l.updatedAt === null || this.now() - l.updatedAt > this.iv.watched) this.schedule(l, 0);
  }

  close(): void {
    this.closed = true;
    for (const l of this.live.values()) if (l.timer) clearTimeout(l.timer);
  }

  private attach(rec: RelayRecord): void {
    const l: Live = { rec, tournamentName: null, currentRound: null, roundName: null, pausedUntil: 0, games: new Map(), rounds: [], past: new Map(), updatedAt: null, error: null, timer: null, polls: 0, busy: false };
    this.live.set(rec.id, l);
    if (this.o.autoStart !== false) this.schedule(l, 0);
  }

  private schedule(l: Live, ms: number): void {
    if (this.closed || this.o.autoStart === false) return;
    if (l.timer) clearTimeout(l.timer);
    l.timer = setTimeout(() => void this.poll(l.rec.id).finally(() => {
      if (!this.live.has(l.rec.id)) return;
      const anyLive = [...l.games.values()].some((g) => g.view.live || (g.view.result === null && g.view.sans.length > 0));
      let ms2 = this.o.watchers(l.rec.id) > 0 ? this.iv.watched : anyLive ? this.iv.idle : this.iv.finished;
      // Lichess : on reste discret (au plus une lecture toutes les 5 s)
      if (l.rec.source === "lichess") ms2 = Math.max(ms2, Math.min(5_000, this.iv.finished));
      ms2 = Math.max(ms2, l.pausedUntil - this.now());
      this.schedule(l, ms2);
    }), ms);
    l.timer.unref?.();
  }

  private summary(l: Live): RelaySummary {
    const games = [...l.games.values()];
    return {
      id: l.rec.id, name: l.rec.name, round: l.rec.round, currentRound: l.currentRound, roundName: l.roundName,
      games: games.length, live: games.some((g) => g.view.live), updatedAt: l.updatedAt, error: l.error,
      rounds: l.rounds.map(({ number, name, state }) => ({ number, name, state })),
    };
  }

  /** Une lecture de la source (publique pour les tests). */
  async poll(id: string): Promise<void> {
    const l = this.live.get(id);
    if (!l || l.busy) return;
    l.busy = true;
    try {
      if (l.rec.source === "lichess") { await this.pollLichess(l); return; }
      const urls = lccUrls(l.rec.lccId, this.o.pool ?? LCC_POOL);
      // tournoi : nom, et ronde à suivre en mode automatique (relu à chaque fois : la ronde peut changer)
      let round = l.rec.round;
      if (round === 0 || l.polls % 10 === 0) {
        const t = (await this.fetchJson(urls.tournament)) as LccTournament | null;
        if (t && typeof t.name === "string") l.tournamentName = t.name.slice(0, 120);
        if (round === 0) round = (t ? await this.autoRound(l, t) : null) ?? l.currentRound ?? 1;
        if (t?.rounds) {
          const cur = round;
          l.rounds = t.rounds.map((r, i) => ({ number: i + 1, count: r?.count ?? 0, live: r?.live ?? 0 }))
            .filter((r) => r.count > 0)
            .map((r) => ({ number: r.number, name: `Ronde ${r.number}`, state: r.live > 0 ? "ongoing" : r.number < cur ? "finished" : r.number === cur ? "unknown" : "upcoming" }));
        }
      }
      const idx = (await this.fetchJson(urls.index(round))) as LccRound | null;
      const pairings = (idx?.pairings ?? []).slice(0, 200);
      const roundChanged = l.currentRound !== round;
      if (roundChanged) { l.games.clear(); l.currentRound = round; }
      const changed: RelayGameView[] = [];
      for (let i = 0; i < pairings.length; i++) {
        const p = pairings[i]!;
        if (!p.white || !p.black) continue;
        const k = i + 1;
        const prev = l.games.get(k);
        // partie terminée et déjà lue : plus besoin de la relire
        const pr = normResult(p.result);
        if (prev?.view.result && (pr === null || pr === prev.view.result)) continue;
        const g = (await this.fetchJson(urls.game(round, k))) as LccGame | null;
        const view = lccGameView(k, p, g, this.now());
        const key = JSON.stringify([view.sans.length, view.result, view.live, view.clocks, view.white.name, view.black.name]);
        if (prev?.key === key) continue;
        l.games.set(k, { view, key });
        changed.push(view);
      }
      l.updatedAt = this.now();
      l.error = null;
      if (roundChanged) this.o.onRound(this.view(l.rec.id)!);
      else for (const g of changed) this.o.onGame(l.rec.id, round, g);
    } catch (e) {
      if (/HTTP 429/.test((e as Error).message)) l.pausedUntil = this.now() + 60_000;
      l.error = "Source injoignable pour le moment (nouvel essai automatique).";
      console.warn("[relay]", l.rec.id, (e as Error).message);
    } finally {
      l.polls++;
      l.busy = false;
    }
  }

  private lichessPgn(url: string): Promise<string | null> {
    const run = this.lichessChain.then(() => this.fetchText(url), () => this.fetchText(url));
    this.lichessChain = run.catch(() => null);
    return run;
  }

  /** Lichess : ronde (suivie automatiquement pour un tournoi) puis toutes ses parties en un seul PGN. */
  private async pollLichess(l: Live): Promise<void> {
    const ref = decodeLichess(l.rec.lccId);
    if (!ref) throw new Error("référence Lichess invalide");
    const base = this.o.lichess ?? LICHESS;
    let roundId = ref.id; let roundNo = 1; let roundName: string | null = l.roundName;
    // lien d'une ronde (« Game 3 ») : on retrouve le tournoi pour suivre aussi les rondes suivantes
    if (ref.kind === "round" && !l.lichessTour && l.polls % 20 === 0) {
      const info = (await this.fetchJson(`${base}/api/broadcast/-/-/${ref.id}`)) as (LichessRoundInfo & { tour?: { id?: string } }) | null;
      if (typeof info?.tour?.name === "string") l.tournamentName = info.tour.name.slice(0, 120);
      if (typeof info?.round?.name === "string") roundName = info.round.name.slice(0, 80);
      if (typeof info?.tour?.id === "string" && /^[A-Za-z0-9]{8}$/.test(info.tour.id)) l.lichessTour = info.tour.id;
    }
    const tourId = ref.kind === "tour" ? ref.id : l.lichessTour;
    // le JSON du tournoi n'est relu que toutes les 45 s (limite Lichess : 30 lectures / 3 min sans compte) ;
    // entre-temps seul le PGN de la ronde est relu, ce qui donne les coups en temps réel
    const pk = l.lichessPick;
    if (tourId && pk && this.now() - pk.at < (pk.soon ? LICHESS_TOUR_SOON : LICHESS_TOUR_EVERY)) {
      ({ id: roundId, number: roundNo, name: roundName } = pk);
    } else if (tourId) {
      const t = (await this.fetchJson(`${base}/api/broadcast/${tourId}`)) as LichessTour | null;
      if (!t) throw new Error("tournoi Lichess introuvable");
      if (typeof t.tour?.name === "string") l.tournamentName = t.tour.name.slice(0, 120);
      l.rounds = (t.rounds ?? []).filter((r) => typeof r.id === "string").map((r, i) => ({
        number: i + 1, name: (r.name ?? `Ronde ${i + 1}`).slice(0, 80), lichessId: r.id!,
        state: r.ongoing ? "ongoing" : r.finished ? "finished" : "upcoming",
      }));
      const pick = pickLichessRound(t, this.now());
      l.lichessPick = pick ? { ...pick, at: this.now() } : null;
      if (!pick) { l.updatedAt = this.now(); l.error = null; return; }
      ({ id: roundId, number: roundNo, name: roundName } = pick);
    }
    if (!tourId) l.rounds = [{ number: 1, name: roundName ?? "Ronde", state: "unknown", lichessId: roundId }];
    const pgn = await this.lichessPgn(`${base}/api/broadcast/round/${roundId}.pgn`);
    const views = pgn ? lichessPgnGames(pgn, this.now()).slice(0, 200) : [];
    const roundChanged = l.currentRound !== roundNo || (!!tourId && l.roundName !== roundName);
    if (roundChanged) { l.games.clear(); l.currentRound = roundNo; }
    l.roundName = roundName;
    const changed: RelayGameView[] = [];
    for (const view of views) {
      const key = JSON.stringify([view.sans.length, view.result, view.live, view.clocks, view.white.name, view.black.name]);
      if (l.games.get(view.index)?.key === key) continue;
      l.games.set(view.index, { view, key });
      changed.push(view);
    }
    l.updatedAt = this.now();
    l.error = null;
    if (roundChanged) this.o.onRound(this.view(l.rec.id)!);
    else for (const g of changed) this.o.onGame(l.rec.id, roundNo, g);
  }

  /**
   * Une ronde précise : la ronde suivie en direct, ou une ronde déjà jouée lue à la demande
   * (gardée en mémoire ; relue au bout de 2 min tant qu'une de ses parties n'est pas terminée).
   */
  async roundView(id: string, n: number): Promise<RelayRoundView | null> {
    const l = this.live.get(id);
    if (!l || !Number.isInteger(n) || n < 1 || n > 500) return null;
    if (n === l.currentRound) return this.view(id);
    const cached = l.past.get(n);
    if (cached && (cached.final || this.now() - cached.at < 120_000)) return cached.view;
    const ref = l.rounds.find((r) => r.number === n);
    let games: RelayGameView[] = [];
    if (l.rec.source === "lichess") {
      if (!ref?.lichessId) return null;
      const pgn = await this.lichessPgn(`${this.o.lichess ?? LICHESS}/api/broadcast/round/${ref.lichessId}.pgn`);
      games = pgn ? lichessPgnGames(pgn, this.now()).slice(0, 200) : [];
    } else {
      const urls = lccUrls(l.rec.lccId, this.o.pool ?? LCC_POOL);
      const idx = (await this.fetchJson(urls.index(n))) as LccRound | null;
      if (!idx) return null;
      const pairings = (idx.pairings ?? []).slice(0, 200);
      for (let i = 0; i < pairings.length; i++) {
        const p = pairings[i]!;
        if (!p.white || !p.black) continue;
        games.push(lccGameView(i + 1, p, (await this.fetchJson(urls.game(n, i + 1))) as LccGame | null, this.now()));
      }
    }
    const view: RelayRoundView = {
      ...this.summary(l), currentRound: n, roundName: ref?.name ?? `Ronde ${n}`,
      games: games.length, live: games.some((g) => g.live), tournamentName: l.tournamentName, gameList: games,
    };
    l.past.set(n, { view, at: this.now(), final: games.length > 0 && games.every((g) => g.result !== null) });
    return view;
  }

  /** Partie connue (ronde en direct ou déjà lue) : sert à vérifier une analyse envoyée par un navigateur. */
  findGame(id: string, round: number, index: number): RelayGameView | null {
    const l = this.live.get(id);
    if (!l) return null;
    if (round === l.currentRound) return l.games.get(index)?.view ?? null;
    return l.past.get(round)?.view.gameList.find((g) => g.index === index) ?? null;
  }

  /** Ronde en cours, sinon la plus récente déjà commencée (quelques lectures au plus). */
  private async autoRound(l: Live, t: LccTournament): Promise<number | null> {
    const cands = roundCandidates(t);
    if (cands.length === 1) return cands[0]!;
    // ronde déjà suivie et toujours parmi les candidates : on la garde tant qu'aucune autre n'est en cours
    for (const r of cands.slice(0, 4)) {
      if (r === l.currentRound) return r;
      const idx = (await this.fetchJson(lccUrls(l.rec.lccId, this.o.pool ?? LCC_POOL).index(r))) as LccRound | null;
      if ((idx?.pairings ?? []).some((p) => p.live || (p.result && p.result !== "*"))) return r;
    }
    return cands.at(-1) ?? null;
  }
}
