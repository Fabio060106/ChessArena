import type { RepertoireGame } from "@chessarena/shared";

/** Une partie importée d'un autre site, vue par le joueur qui l'a importée. */
export interface ImportedGame {
  source: "lichess";
  extId: string;
  account: string;
  playedAt: string;
  color: "w" | "b";
  opponent: string;
  outcome: "win" | "loss" | "draw";
  speed: string;
  opening: string | null;
  pgn: string;
}

export const IMPORT_MAX_GAMES = 500;
export const IMPORT_SPEEDS = ["bullet", "blitz", "rapid", "classical"] as const;
export type ImportSpeed = (typeof IMPORT_SPEEDS)[number];

/** Pseudo Lichess valide (lettres, chiffres, _ et -, 2 à 30 caractères). */
export const validLichessName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/.test(s);

/** Adresse de l'export des parties d'un joueur (format NDJSON : une partie JSON par ligne). */
export function lichessGamesUrl(base: string, username: string, max: number, speeds: readonly ImportSpeed[]): string {
  const q = new URLSearchParams({
    max: String(Math.min(Math.max(1, Math.floor(max)), IMPORT_MAX_GAMES)),
    perfType: speeds.join(","),
    moves: "true", tags: "true", clocks: "false", evals: "false", opening: "true", literate: "false",
  });
  return `${base.replace(/\/$/, "")}/api/games/user/${encodeURIComponent(username)}?${q}`;
}

interface LichessPlayer { user?: { name?: string; id?: string; title?: string }; rating?: number; aiLevel?: number }
interface LichessGame {
  id?: string; variant?: string; speed?: string; createdAt?: number; status?: string; winner?: "white" | "black";
  initialFen?: string; players?: { white?: LichessPlayer; black?: LichessPlayer };
  opening?: { eco?: string; name?: string }; moves?: string;
}

const pname = (p: LichessPlayer | undefined) => (p?.aiLevel ? `Stockfish niveau ${p.aiLevel}` : p?.user?.name ?? "Anonyme");
const esc = (s: string) => s.replace(/["\\]/g, "");

/** PGN minimal (en-têtes + coups numérotés) d'une partie Lichess. */
export function lichessPgn(g: LichessGame, result: string): string {
  const d = new Date(g.createdAt ?? 0);
  const date = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
  const sans = (g.moves ?? "").split(" ").filter(Boolean);
  const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
  const tags = [
    ["Event", `Lichess ${g.speed ?? ""}`.trim()], ["Site", `https://lichess.org/${g.id}`], ["Date", date],
    ["White", pname(g.players?.white)], ["Black", pname(g.players?.black)], ["Result", result],
    ...(g.players?.white?.rating ? [["WhiteElo", String(g.players.white.rating)]] : []),
    ...(g.players?.black?.rating ? [["BlackElo", String(g.players.black.rating)]] : []),
    ...(g.opening?.eco ? [["ECO", g.opening.eco]] : []),
    ...(g.opening?.name ? [["Opening", g.opening.name]] : []),
  ];
  return `${tags.map(([k, v]) => `[${k} "${esc(v!)}"]`).join("\n")}\n\n${body} ${result}\n`;
}

/**
 * Lit l'export NDJSON de Lichess et garde les parties utilisables pour le répertoire :
 * échecs standard depuis la position initiale, terminées (pas annulées), avec au moins quelques coups.
 */
export function parseLichessExport(ndjson: string, username: string): ImportedGame[] {
  const me = username.toLowerCase();
  const out: ImportedGame[] = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let g: LichessGame;
    try { g = JSON.parse(line) as LichessGame; } catch { continue; }
    if (!g.id || !/^[A-Za-z0-9]{8}$/.test(g.id) || (g.variant && g.variant !== "standard") || g.initialFen) continue;
    if (!g.status || ["created", "started", "aborted", "noStart", "unknownFinish"].includes(g.status)) continue;
    const sans = (g.moves ?? "").split(" ").filter(Boolean);
    if (sans.length < 4) continue;
    const white = g.players?.white?.user?.id?.toLowerCase() === me;
    const black = g.players?.black?.user?.id?.toLowerCase() === me;
    if (white === black) continue;
    const color: "w" | "b" = white ? "w" : "b";
    const outcome: ImportedGame["outcome"] = !g.winner ? "draw" : (g.winner === "white") === white ? "win" : "loss";
    const result = !g.winner ? "1/2-1/2" : g.winner === "white" ? "1-0" : "0-1";
    const opp = white ? g.players?.black : g.players?.white;
    const pgn = lichessPgn(g, result);
    if (Buffer.byteLength(pgn) > 20_000) continue;
    out.push({
      source: "lichess", extId: g.id, account: username, playedAt: new Date(g.createdAt ?? Date.now()).toISOString(),
      color, opponent: `${pname(opp)}${opp?.rating ? ` (${opp.rating})` : ""}`.slice(0, 80), outcome,
      speed: (g.speed ?? "").slice(0, 20), opening: g.opening?.name?.slice(0, 120) ?? null, pgn,
    });
  }
  return out;
}

/** Pour le répertoire : une partie importée a la même forme qu'une partie jouée sur le site. */
export function importedToRepertoire(g: ImportedGame): RepertoireGame {
  return {
    gameId: `${g.source}:${g.extId}`, endedAt: g.playedAt, color: g.color, opponent: g.opponent, outcome: g.outcome,
    timeControl: g.speed === "rapid" || g.speed === "classical" ? "rapid_5_0" : g.speed === "bullet" ? "bullet_1_0" : "blitz_3_0",
    pgn: g.pgn, source: g.source,
  };
}

export interface ImportStatus {
  state: "idle" | "running" | "done" | "error";
  account: string | null;
  /** parties trouvées / nouvelles lors du dernier import */
  found: number;
  added: number;
  error: string | null;
  at: number;
}

/**
 * Imports en cours (un par joueur, en arrière-plan : Lichess envoie environ 20 parties par seconde sans compte).
 * Un nouvel import n'est possible qu'une minute après le précédent.
 */
export class ImportService {
  private readonly jobs = new Map<string, ImportStatus>();
  constructor(private readonly o: {
    fetchText: (url: string) => Promise<string | null>;
    save: (userId: string, games: ImportedGame[]) => Promise<number>;
    lichess?: string;
    now?: () => number;
  }) {}
  private now() { return this.o.now?.() ?? Date.now(); }

  status(userId: string): ImportStatus {
    return this.jobs.get(userId) ?? { state: "idle", account: null, found: 0, added: 0, error: null, at: 0 };
  }

  /** Lance l'import ; renvoie l'état (ou une erreur si un import tourne déjà ou vient de se terminer). */
  start(userId: string, username: string, max: number, speeds: readonly ImportSpeed[]): ImportStatus | "BUSY" | "TOO_SOON" {
    const cur = this.jobs.get(userId);
    if (cur?.state === "running") return "BUSY";
    if (cur && this.now() - cur.at < 60_000) return "TOO_SOON";
    const st: ImportStatus = { state: "running", account: username, found: 0, added: 0, error: null, at: this.now() };
    this.jobs.set(userId, st);
    if (this.jobs.size > 5000) this.jobs.delete(this.jobs.keys().next().value!);
    void (async () => {
      try {
        const text = await this.o.fetchText(lichessGamesUrl(this.o.lichess ?? "https://lichess.org", username, max, speeds));
        if (text === null) throw new Error("NOT_FOUND");
        const games = parseLichessExport(text, username);
        st.found = games.length;
        st.added = games.length ? await this.o.save(userId, games) : 0;
        st.state = "done";
      } catch (e) {
        st.state = "error";
        st.error = (e as Error).message === "NOT_FOUND" ? "NOT_FOUND" : (e as Error).message === "RATE_LIMITED" ? "RATE_LIMITED" : "FAILED";
        console.warn("[import] échec", username, (e as Error).message);
      } finally {
        st.at = this.now();
      }
    })();
    return st;
  }
}

/** Téléchargement de l'export Lichess (jusqu'à 3 minutes : Lichess envoie les parties au fil de l'eau). */
export async function fetchLichessExport(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 180_000);
  try {
    const r = await fetch(url, { headers: { accept: "application/x-ndjson", "user-agent": "ChessAurum (import de parties)" }, signal: ctl.signal });
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error("RATE_LIMITED");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
