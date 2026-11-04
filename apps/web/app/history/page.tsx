"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GameHistoryDetail, GameHistoryItem, TimeControlId } from "@chessarena/shared";
import { GameBoard } from "../../components/GameBoard";
import { MoveList } from "../../components/MoveList";
import { PlayerCard } from "../../components/PlayerCard";
import { useSettings } from "../../lib/settings";
import { material } from "../../lib/material";
import { materialAdvantage } from "../../lib/profile";
import { formatThink, relativeDate, replayFromPgn } from "../../lib/replay";
import { MoveNav, usePlyKeys } from "../../components/MoveNav";
import { accuracy, classify, Engine, ENGINE_NAME, formatScore, pvToSan, scoreToCp, terminalScore, winPct, type EngineLine, type MoveMark, type Score } from "../../lib/engine";

const TC: Record<TimeControlId, string> = { bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0" };
const TERM: Record<string, string> = {
  checkmate: "échec et mat", resignation: "abandon", timeout: "temps écoulé", abandon: "forfait", stalemate: "pat",
  repetition: "répétition", insufficient_material: "matériel insuffisant", fifty_moves: "50 coups", aborted: "annulée",
  agreement: "accord mutuel", timeout_vs_insufficient_material: "temps, matériel insuffisant",
};
const OUTCOME = {
  win: { label: "Victoire", cls: "bg-win/15 text-win" },
  loss: { label: "Défaite", cls: "bg-danger/15 text-danger" },
  draw: { label: "Nulle", cls: "bg-surface-2 text-text" },
  aborted: { label: "Annulée", cls: "bg-surface-2 text-muted" },
} as const;

/** Historique des parties du joueur connecté, avec relecture coup par coup. */
export default function HistoryPage() {
  const router = useRouter();
  const [me, setMe] = useState<string | null>(null);
  const [games, setGames] = useState<GameHistoryItem[] | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMe(((await r.json()) as { userId: string }).userId) : router.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)))
      .catch(() => router.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`));
  }, [router]);

  const load = useCallback(async (before?: string) => {
    setError(null);
    const r = await fetch(`/api/history${before ? `?before=${encodeURIComponent(before)}` : ""}`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok) {
      setError(r?.status === 503 ? "L'historique nécessite la base de données du serveur." : "Impossible de charger l'historique (le serveur se réveille peut-être : réessaie dans une minute).");
      setGames((g) => g ?? []);
      return;
    }
    const page = ((await r.json()) as { games: GameHistoryItem[] }).games;
    setGames((g) => [...(before ? g ?? [] : []), ...page]);
    setMore(page.length === 30);
    const wanted = new URLSearchParams(window.location.search).get("g");
    if (!before && wanted && /^[0-9a-f-]{36}$/i.test(wanted)) setSelected((s) => s ?? wanted);
    else if (!before && page[0]) setSelected((s) => s ?? page[0]!.gameId);
  }, []);
  useEffect(() => { if (me) void load(); }, [me, load]);

  const stats = useMemo(() => {
    const played = (games ?? []).filter((g) => g.outcome !== "aborted");
    return { n: played.length, w: played.filter((g) => g.outcome === "win").length, d: played.filter((g) => g.outcome === "draw").length, l: played.filter((g) => g.outcome === "loss").length };
  }, [games]);

  return (
    <main className="arena-app">
      <header className="mx-auto flex h-13 max-w-[1400px] items-center gap-3 px-3 lg:px-6">
        <a href="/play" className="font-display text-lg font-bold tracking-tight">Chess<span className="text-neon">Arena</span></a>
        <span className="text-sm text-muted">· Mes parties</span>
        <a href="/repertoire" className="ml-auto rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">Répertoire</a>
        <a href="/play" className="neon-btn rounded-lg px-3 py-1.5 text-sm font-semibold">Jouer</a>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-4 px-2 pb-8 sm:px-3 lg:grid-cols-[380px_minmax(0,1fr)] lg:px-6">
        <section className="flex flex-col gap-3">
          {stats.n > 0 && (
            <div className="panel grid grid-cols-4 gap-2 p-3 text-center">
              <Stat label="Parties" value={stats.n} />
              <Stat label="Victoires" value={stats.w} cls="text-win" />
              <Stat label="Nulles" value={stats.d} />
              <Stat label="Défaites" value={stats.l} cls="text-danger" />
            </div>
          )}
          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-sm text-danger">{error}</p>}
          {games === null && <p className="px-1 text-sm text-muted">Chargement…</p>}
          {games?.length === 0 && !error && (
            <div className="panel p-4 text-sm text-muted">Aucune partie pour l'instant. <a href="/play" className="text-neon underline">Joue ta première partie</a>.</div>
          )}
          <ul className="flex flex-col gap-1.5">
            {games?.map((g) => (
              <li key={g.gameId}>
                <button type="button" onClick={() => setSelected(g.gameId)}
                  className={`panel flex w-full items-center gap-3 p-3 text-left transition ${selected === g.gameId ? "border-neon/60 ring-1 ring-neon/30" : "hover:border-line"}`}>
                  <span className={`w-20 shrink-0 rounded-md px-2 py-1 text-center text-xs font-semibold ${OUTCOME[g.outcome].cls}`}>{OUTCOME[g.outcome].label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block size-2.5 rounded-sm border border-line ${g.color === "w" ? "bg-[#E7ECF3]" : "bg-[#1C2233]"}`} aria-label={g.color === "w" ? "Blancs" : "Noirs"} />
                      <span className="truncate font-semibold">{g.opponent}</span>
                      {g.opponentRating !== null && <span className="tabular text-xs text-muted">{g.opponentRating}</span>}
                    </span>
                    <span className="block text-xs text-muted">{TC[g.timeControl]} · {TERM[g.termination] ?? g.termination} · {Math.ceil(g.plies / 2)} coups{g.tournamentId ? " · tournoi" : ""}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    {g.ratingBefore !== null && g.ratingAfter !== null && (
                      <span className={`tabular block font-semibold ${g.ratingAfter >= g.ratingBefore ? "text-win" : "text-danger"}`}>
                        {g.ratingAfter >= g.ratingBefore ? "+" : ""}{g.ratingAfter - g.ratingBefore}
                      </span>
                    )}
                    <span className="text-muted">{relativeDate(g.endedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {games && games.length > 0 && more && (
            <button type="button" onClick={() => void load(games[games.length - 1]!.endedAt)} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">
              Parties plus anciennes
            </button>
          )}
        </section>

        <section>{selected && me ? <Replay key={selected} gameId={selected} me={me} /> : null}</section>
      </div>
    </main>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: number; cls?: string }) {
  return (
    <div>
      <p className={`tabular font-display text-xl font-bold ${cls}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}

/** Profondeurs : passe rapide sur toute la partie, puis analyse plus poussée de la position affichée. */
const PASS_DEPTH = 11;
const LIVE_DEPTH = 20;

/** Relecture d'une partie : plateau, navigation ◀ ▶ (et flèches du clavier), liste des coups cliquable, analyse Stockfish. */
function Replay({ gameId, me }: { gameId: string; me: string }) {
  const [g, setG] = useState<GameHistoryDetail | null>(null);
  const [err, setErr] = useState(false);
  const [ply, setPly] = useState(0);
  const [settings] = useSettings();

  useEffect(() => {
    fetch(`/api/history/${gameId}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const d = (await r.json()) as GameHistoryDetail;
        setG(d);
        setPly(replayFromPgn(d.pgn).length - 1); // on arrive sur la position finale
      })
      .catch(() => setErr(true));
  }, [gameId]);

  const steps = useMemo(() => (g ? replayFromPgn(g.pgn) : []), [g]);
  const last = steps.length - 1;
  const go = useCallback((p: number) => setPly(Math.max(0, Math.min(last, p))), [last]);
  usePlyKeys(ply, last, go, steps.length > 0);
  const an = useAnalysis(steps.map((s) => s.fen), ply);

  if (err) return <p className="panel p-4 text-sm text-danger">Impossible de charger cette partie.</p>;
  if (!g) return <p className="panel p-4 text-sm text-muted">Chargement de la partie…</p>;

  const step = steps[ply]!;
  const mat = material(step.fen);
  const opp = g.color === "w" ? "b" : "w";
  const thinkOf = (p: number) => formatThink(g.moveTimesMs[p - 1]);
  const line = an.on ? an.line : null;
  const bestArrow = line?.pv[0] ? [{ from: line.pv[0].slice(0, 2), to: line.pv[0].slice(2, 4) }] : [];
  // coup réellement joué depuis cette position, s'il diffère du meilleur coup (rouge si c'est une erreur)
  const played = steps[ply + 1]?.uci;
  const playedMark = an.marks[ply];
  const arrows = an.on && played && playedMark && line?.pv[0] !== played
    ? [...bestArrow, { from: played.slice(0, 2), to: played.slice(2, 4), color: playedMark === "??" ? "#ef4444" : playedMark === "?" ? "#fb923c" : "#eab308" }]
    : bestArrow;

  return (
    <div className="mx-auto flex w-full flex-col gap-1.5" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 220px)))" }}>
      <PlayerCard userId={g.opponent} rating={g.opponentRating ?? undefined}
        materialAdvantage={materialAdvantage(step.fen, opp)} captured={mat[opp].captured}
        clock={<span className="tabular text-xs text-muted">{ply > 0 && ply % 2 === (opp === "w" ? 1 : 0) ? thinkOf(ply) : ""}</span>} />
      {an.on && <EvalBar score={an.scoreAt(ply)} flip={g.color === "b"} />}
      <GameBoard
        fen={step.fen} serverFen={step.fen} orientation={g.color} myColor={g.color} interactive={false} myTurn={false}
        lastMove={step.uci} premoves={[]} theme={settings.boardTheme} coordinates={settings.coordinates}
        onMove={() => false} onCancelPremoves={() => {}} arrows={arrows}
      />
      <PlayerCard userId={me} isMe rating={g.ratingBefore ?? undefined}
        materialAdvantage={materialAdvantage(step.fen, g.color)} captured={mat[g.color].captured}
        clock={<span className="tabular text-xs text-muted">{ply > 0 && ply % 2 === (g.color === "w" ? 1 : 0) ? thinkOf(ply) : ""}</span>} />
      <MoveNav ply={ply} last={last} go={go} />

      <div className="panel p-3">
        {!an.on ? (
          <button type="button" onClick={an.start} className="neon-btn w-full rounded-lg px-3 py-2.5 font-semibold">
            Analyser avec {ENGINE_NAME}
          </button>
        ) : an.failed ? (
          <p className="text-sm text-danger">Le moteur n'a pas pu démarrer sur ce navigateur.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold">
                <span className="text-neon">{ENGINE_NAME}</span>
                {an.scoreAt(ply) && <span className="tabular ml-2 font-display text-lg">{formatScore(an.scoreAt(ply)!)}</span>}
              </p>
              <p className="tabular text-xs text-muted">
                {an.progress < 1 ? `analyse de la partie… ${Math.round(an.progress * 100)} %` : line ? `profondeur ${line.depth}` : ""}
              </p>
            </div>
            {an.progress < 1 && <div className="h-1 overflow-hidden rounded bg-surface-2"><div className="h-full bg-neon transition-all" style={{ width: `${an.progress * 100}%` }} /></div>}
            {line && line.pv.length > 0 && (
              <p className="text-sm"><span className="text-muted">Meilleure suite : </span><span className="font-medium">{pvLabel(step.fen, line.pv)}</span></p>
            )}
            {an.progress >= 1 && <EvalGraph evals={an.evals} ply={ply} onPick={go} />}
            {an.progress >= 1 && <Summary marks={an.marks} evals={an.evals} me={g.color} meName={me} oppName={g.opponent} />}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">{OUTCOME[g.outcome].label} · {g.result} <span className="font-normal text-muted">({TERM[g.termination] ?? g.termination})</span></p>
          <p className="text-xs text-muted">{TC[g.timeControl]} · {new Date(g.endedAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}</p>
        </div>
        <MoveList moves={steps.slice(1).map((s) => s.san)} active={ply - 1} onSelect={(p) => go(p + 1)} marks={an.marks.slice(0, -1)} />
        <p className="mt-2 text-[11px] text-muted">Flèches ← → du clavier pour avancer coup par coup.{an.on ? " Flèche bleue : meilleur coup du moteur ; flèche orange/rouge : le coup joué, quand c'est une erreur." : ""}</p>
      </div>
      {an.on && (
        <p className="px-1 text-[11px] text-muted/70">
          Moteur {ENGINE_NAME} (stockfish.js, licence GPLv3 — <a className="underline" href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noreferrer">code source</a>) exécuté dans ton navigateur.
          Disponible uniquement sur les parties terminées.
        </p>
      )}
    </div>
  );
}

function pvLabel(fen: string, pv: string[]): string {
  const sans = pvToSan(fen, pv, 8);
  const [, turn, , , , full] = fen.split(" ");
  let n = Number(full); let black = turn === "b";
  return sans.map((san, i) => {
    const pre = !black ? `${n}. ` : i === 0 ? `${n}… ` : "";
    if (black) n++;
    black = !black;
    return pre + san;
  }).join(" ");
}

/**
 * Analyse d'une partie terminée : une passe rapide évalue chaque position (annotations ?! ? ??, courbe, précision),
 * puis la position affichée est approfondie. `marks[i]` annote le coup joué DEPUIS la position i.
 */
function useAnalysis(fens: string[], ply: number) {
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const [evals, setEvals] = useState<Array<Score | null>>([]);
  const [progress, setProgress] = useState(0);
  const [line, setLine] = useState<EngineLine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const key = fens.join("|");

  useEffect(() => () => engine?.terminate(), [engine]);

  const start = useCallback(() => {
    setOn(true);
    try { setEngine(new Engine()); } catch { setFailed(true); }
  }, []);

  // 1. passe rapide sur toute la partie
  useEffect(() => {
    if (!engine || fens.length === 0) return;
    let cancelled = false;
    const out: Array<Score | null> = fens.map((f) => terminalScore(f));
    setEvals([...out]); setProgress(0);
    (async () => {
      for (let i = 0; i < fens.length; i++) {
        if (cancelled) return;
        if (out[i] === null) {
          const l = await engine.analyse(fens[i]!, PASS_DEPTH);
          if (cancelled) return;
          out[i] = l?.score ?? null;
        }
        setProgress((i + 1) / fens.length);
        if (i % 4 === 3 || i === fens.length - 1) setEvals([...out]);
      }
    })().catch(() => setFailed(true));
    return () => { cancelled = true; engine.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, key]);

  // 2. approfondissement de la position affichée (une fois la passe terminée)
  useEffect(() => {
    if (!engine || progress < 1) return;
    setLine(null);
    const fen = fens[ply]!;
    let live = true;
    void engine.analyse(fen, LIVE_DEPTH, (l) => { if (live) setLine(l); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, progress >= 1, ply, key]);

  const cps = evals.map((e) => (e ? scoreToCp(e) : 0));
  const marks: MoveMark[] = fens.map(() => null);
  // le premier coup de la position i est joué par le trait de la position i
  const turnOf = (i: number) => (fens[i]?.split(" ")[1] === "b" ? "b" : "w");
  for (let i = 0; i + 1 < fens.length; i++) {
    if (evals[i] && evals[i + 1]) marks[i] = classify(cps[i]!, cps[i + 1]!, turnOf(i));
  }
  const scoreAt = (p: number): Score | null => (p === ply && line && progress >= 1 ? line.score : evals[p] ?? null);
  return { on, failed, start, progress: engine ? progress : 0, evals: cps, marks, line, scoreAt };
}

/** Barre d'évaluation horizontale : part des Blancs = chances de gain. */
function EvalBar({ score, flip }: { score: Score | null; flip: boolean }) {
  const w = score ? winPct(scoreToCp(score)) : 50;
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-[#1C2233] ring-1 ring-line" aria-label="Barre d'évaluation">
      <div className="absolute inset-y-0 bg-[#E7ECF3] transition-all duration-300" style={flip ? { right: 0, width: `${w}%` } : { left: 0, width: `${w}%` }} />
      <div className="absolute inset-y-0 left-1/2 w-px bg-neon/60" />
    </div>
  );
}

/** Courbe des chances de gain des Blancs, cliquable pour aller au coup. */
function EvalGraph({ evals, ply, onPick }: { evals: number[]; ply: number; onPick: (p: number) => void }) {
  const n = Math.max(1, evals.length - 1);
  const pts = evals.map((cp, i) => `${(i / n) * 100},${100 - winPct(cp)}`).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-16 w-full cursor-pointer rounded bg-[#1C2233]"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onPick(Math.round(((e.clientX - r.left) / r.width) * n)); }}
      role="img" aria-label="Courbe d'évaluation">
      <polygon points={`0,100 ${pts} 100,100`} fill="#E7ECF3" opacity={0.85} />
      <line x1="0" y1="50" x2="100" y2="50" stroke="#22d3ee" strokeOpacity={0.4} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      <line x1={(ply / n) * 100} y1="0" x2={(ply / n) * 100} y2="100" stroke="#22d3ee" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Précision et nombre d'imprécisions / erreurs / gaffes de chaque joueur. */
function Summary({ marks, evals, me, meName, oppName }: { marks: MoveMark[]; evals: number[]; me: "w" | "b"; meName: string; oppName: string }) {
  const row = (c: "w" | "b", name: string) => {
    const mine = marks.filter((m, i) => m && (i % 2 === 0 ? "w" : "b") === c);
    const count = (k: MoveMark) => mine.filter((m) => m === k).length;
    const acc = accuracy(evals, c);
    return (
      <tr key={c}>
        <td className="truncate py-1 pr-2 font-medium">{name}</td>
        <td className="tabular text-right font-semibold text-neon">{acc !== null ? `${acc} %` : "—"}</td>
        <td className="tabular text-right text-gold">{count("?!")}</td>
        <td className="tabular text-right text-[#fb923c]">{count("?")}</td>
        <td className="tabular text-right text-danger">{count("??")}</td>
      </tr>
    );
  };
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="text-[11px] uppercase tracking-wider text-muted">
        <tr><th className="w-2/5 text-left font-normal">Joueur</th><th className="text-right font-normal">Précision</th><th className="text-right font-normal">?!</th><th className="text-right font-normal">?</th><th className="text-right font-normal">??</th></tr>
      </thead>
      <tbody>{me === "w" ? [row("w", meName), row("b", oppName)] : [row("w", oppName), row("b", meName)]}</tbody>
    </table>
  );
}
