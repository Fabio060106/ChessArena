"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import type { GameHistoryDetail, GameHistoryItem, TimeControlId } from "@chessarena/shared";
import { GameBoard } from "./GameBoard";
import { MoveList } from "./MoveList";
import { PlayerCard } from "./PlayerCard";
import { useSettings } from "../lib/settings";
import { material } from "../lib/material";
import { materialAdvantage } from "../lib/profile";
import { formatThink, relativeDate, replayFromPgn } from "../lib/replay";
import { MoveNav, usePlyKeys } from "./MoveNav";
import { FlipButton } from "./SiteNav";
import { useFlip } from "../hooks/useFlip";
import { fetchWake, localCache } from "../lib/wake";
import { applyMove, atMain, currentStep, numbered, playOnBoard, previousStep, type Cursor } from "../lib/variation";
import { moveSound, sound } from "../lib/sound";
import { accuracy, classify, Engine, ENGINE_NAME, formatScore, pvToSan, scoreToCp, terminalScore, winPct, type EngineLine, type MoveMark, type Score } from "../lib/engine";

export const TC: Record<TimeControlId, string> = { bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0" };
export const TERM: Record<string, string> = {
  checkmate: "échec et mat", resignation: "abandon", timeout: "temps écoulé", abandon: "forfait", stalemate: "pat",
  repetition: "répétition", insufficient_material: "matériel insuffisant", fifty_moves: "50 coups", aborted: "annulée",
  agreement: "accord mutuel", timeout_vs_insufficient_material: "temps, matériel insuffisant",
};
export const OUTCOME = {
  win: { label: "Victoire", cls: "bg-win/15 text-win" },
  loss: { label: "Défaite", cls: "bg-danger/15 text-danger" },
  draw: { label: "Nulle", cls: "bg-surface-2 text-text" },
  aborted: { label: "Annulée", cls: "bg-surface-2 text-muted" },
} as const;

const PASS_DEPTH = 11;
const LIVE_DEPTH = 20;

/**
 * Relecture + analyse d'une partie. `publicView` : partie d'un autre joueur (lien partagé), vue du côté des Blancs
 * (ou du joueur s'il y a participé), résultat affiché sans « Victoire / Défaite ».
 * `initial` : position (ply) et variante (coups UCI) à ouvrir, depuis un lien partagé.
 */
export function GameReplay({ gameId, me: viewer, publicView = false, initial }: {
  gameId: string; me: string; publicView?: boolean; initial?: { ply?: number; variation?: string[] };
}) {
  const [g, setG] = useState<GameHistoryDetail | null>(null);
  const [err, setErr] = useState(false);
  const [cur, setCur] = useState<Cursor>(atMain(0));
  const [settings] = useSettings();
  const [flipped, flip] = useFlip(gameId);

  // position d'arrivée : celle du lien partagé (ply + variante), sinon la position finale
  const startAt = useCallback((d: GameHistoryDetail) => {
    const main = replayFromPgn(d.pgn);
    const base = initial?.ply !== undefined ? Math.max(0, Math.min(main.length - 1, initial.ply)) : main.length - 1;
    let c: Cursor = atMain(base);
    for (const u of initial?.variation ?? []) {
      const m = applyMove(currentStep(main, c).fen, u.slice(0, 2), u.slice(2, 4), u[4] || undefined);
      if (!m) break;
      c = playOnBoard(main, c, m);
    }
    setCur(c);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const key = `${publicView ? "pgame" : "game"}.${gameId}`;
    const cached = localCache.get<GameHistoryDetail>(key);
    if (cached) { setG(cached); startAt(cached); }
    fetchWake(publicView ? `/api/games/${gameId}` : `/api/history/${gameId}`)
      .then(async (r) => {
        if (!r?.ok) { if (cached) return; throw new Error(String(r?.status ?? "")); }
        const d = (await r.json()) as GameHistoryDetail;
        localCache.set(key, d);
        if (cached) return; // déjà affichée (une partie terminée ne change plus)
        setG(d);
        startAt(d);
      })
      .catch(() => setErr(true));
  }, [gameId, publicView, startAt]);

  const steps = useMemo(() => (g ? replayFromPgn(g.pgn) : []), [g]);
  const last = steps.length - 1;
  const ply = cur.ply;
  const v = cur.variation;
  const go = useCallback((p: number) => setCur(atMain(Math.max(0, Math.min(last, p)))), [last]);
  // dans une variante, ◀ ▶ parcourent la variante ; ◀ depuis son point de départ ramène à la partie
  const goVar = useCallback((k: number) => setCur((c) => {
    if (!c.variation) return c;
    if (k < 0) return atMain(c.variation.base);
    return { ...c, vply: Math.min(k, c.variation.steps.length) };
  }), []);
  usePlyKeys(v ? cur.vply : ply, v ? v.steps.length : last, v ? goVar : go, steps.length > 0);
  const shown = steps.length ? currentStep(steps, cur) : null;
  const prevFen = cur.variation && cur.vply > 0 ? previousStep(steps, cur)!.fen : null;
  const an = useAnalysis(steps.map((s) => s.fen), ply, shown?.fen ?? "", prevFen);

  const onMove = useCallback((from: string, to: string, promotion?: string) => {
    if (!shown) return false;
    const m = applyMove(shown.fen, from, to, promotion ?? (isPromotionMove(shown.fen, from, to) ? "q" : undefined));
    if (!m) return false;
    sound.play(moveSound(m));
    setCur((c) => playOnBoard(steps, c, m));
    if (!an.on) an.start();
    return true;
  }, [shown, steps, an]);

  if (err) return <p className="panel p-4 text-sm text-danger">Impossible de charger cette partie (lien erroné, ou partie pas encore terminée).</p>;
  if (!g || !shown) return <p className="panel p-4 text-sm text-muted">Chargement de la partie…</p>;

  const fen = shown.fen;
  const toMove = fen.split(" ")[1] === "b" ? "b" : "w";
  const mat = material(fen);
  const opp = g.color === "w" ? "b" : "w";
  const thinkOf = (p: number) => (v ? "" : formatThink(g.moveTimesMs[p - 1]));
  const line = an.on ? an.line : null;
  const bestArrow = line?.pv[0] ? [{ from: line.pv[0].slice(0, 2), to: line.pv[0].slice(2, 4) }] : [];
  // coup réellement joué depuis cette position, s'il diffère du meilleur coup (rouge si c'est une erreur)
  const played = v ? undefined : steps[ply + 1]?.uci;
  const playedMark = an.marks[ply];
  const arrows = an.on && played && playedMark && line?.pv[0] !== played
    ? [...bestArrow, { from: played.slice(0, 2), to: played.slice(2, 4), color: playedMark === "??" ? "#ef4444" : playedMark === "?" ? "#fb923c" : "#eab308" }]
    : bestArrow;
  // point de vue : le joueur connecté s'il a joué la partie, sinon les Blancs (partie partagée)
  const me = g.player ?? viewer;
  const neutral = publicView && me !== viewer;
  const oppCard = (
    <PlayerCard userId={g.opponent} rating={g.opponentRating ?? undefined}
      materialAdvantage={materialAdvantage(fen, opp)} captured={mat[opp].captured}
      clock={<span className="tabular text-xs text-muted">{ply > 0 && ply % 2 === (opp === "w" ? 1 : 0) ? thinkOf(ply) : ""}</span>} />
  );
  const myCard = (
    <PlayerCard userId={me} isMe={!neutral} rating={g.ratingBefore ?? undefined}
      materialAdvantage={materialAdvantage(fen, g.color)} captured={mat[g.color].captured}
      clock={<span className="tabular text-xs text-muted">{ply > 0 && ply % 2 === (g.color === "w" ? 1 : 0) ? thinkOf(ply) : ""}</span>} />
  );
  const verdict = v && cur.vply > 0 ? an.judge(previousStep(steps, cur)!.fen, shown) : null;

  return (
    <div className="mx-auto flex w-full flex-col gap-1.5" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 220px)))" }}>
      {flipped ? myCard : oppCard}
      {an.on && <EvalBar score={an.viewScore} flip={(g.color === "b") !== flipped} />}
      <GameBoard
        fen={fen} serverFen={fen} orientation={flipped ? opp : g.color} myColor={toMove} interactive myTurn
        lastMove={shown.uci} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
        onMove={onMove} onCancelPremoves={() => {}} arrows={arrows}
      />
      {flipped ? oppCard : myCard}
      <div className="flex gap-1.5">
        <div className="flex-1">{v ? <MoveNav ply={cur.vply} last={v.steps.length} go={goVar} /> : <MoveNav ply={ply} last={last} go={go} />}</div>
        <FlipButton onFlip={flip} className="!px-3 text-lg" />
      </div>

      {v && (
        <div className="panel border-neon/40 p-3" aria-label="Ta variante">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">Ta variante <span className="font-normal text-muted">{v.base === 0 ? "depuis la position initiale" : `après ${numbered(steps[v.base - 1]!.fen, [steps[v.base]!.san])[0]}`}</span></p>
            <button type="button" onClick={() => setCur(atMain(v.base))} className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs text-muted hover:text-text">
              ✕ Revenir à la partie
            </button>
          </div>
          <p className="flex flex-wrap gap-x-1 gap-y-0.5 text-sm">
            {numbered(steps[v.base]!.fen, v.steps.map((s) => s.san)).map((label, i) => (
              <button key={i} type="button" onClick={() => goVar(i + 1)}
                className={`rounded px-1 ${cur.vply === i + 1 ? "bg-neon/20 font-semibold text-neon" : "hover:bg-surface-2"}`}>{label}</button>
            ))}
          </p>
          {verdict && (
            <p className={`mt-2 text-sm ${verdict.mark === "??" ? "text-danger" : verdict.mark === "?" ? "text-[#fb923c]" : verdict.mark === "?!" ? "text-gold" : "text-win"}`}>
              {verdict.pending ? <span className="text-muted">Le moteur évalue {shown.san}…</span> : (
                <>
                  <span className="font-semibold">{shown.san}{verdict.mark ?? ""}</span> — {VERDICT[verdict.mark ?? "ok"]}
                  {verdict.mark && verdict.best && <span className="text-muted"> Le meilleur était {verdict.best}.</span>}
                </>
              )}
            </p>
          )}
        </div>
      )}

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
                {an.viewScore && <span className="tabular ml-2 font-display text-lg">{formatScore(an.viewScore)}</span>}
              </p>
              <p className="tabular text-xs text-muted">
                {an.progress < 1 ? `analyse de la partie… ${Math.round(an.progress * 100)} %` : line ? `profondeur ${line.depth}` : ""}
              </p>
            </div>
            {an.progress < 1 && <div className="h-1 overflow-hidden rounded bg-surface-2"><div className="h-full bg-neon transition-all" style={{ width: `${an.progress * 100}%` }} /></div>}
            {line && line.pv.length > 0 && (
              <p className="text-sm"><span className="text-muted">Meilleure suite : </span><span className="font-medium">{pvLabel(fen, line.pv)}</span></p>
            )}
            {an.progress >= 1 && <EvalGraph evals={an.evals} ply={ply} onPick={go} />}
            {an.progress >= 1 && <Summary marks={an.marks} evals={an.evals} me={g.color} meName={me} oppName={g.opponent} />}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">
            {neutral ? (g.result === "1-0" ? "Victoire des Blancs" : g.result === "0-1" ? "Victoire des Noirs" : OUTCOME[g.outcome].label) : OUTCOME[g.outcome].label} · {g.result}{" "}
            <span className="font-normal text-muted">({TERM[g.termination] ?? g.termination})</span>
          </p>
          <p className="text-xs text-muted">{TC[g.timeControl]} · {new Date(g.endedAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}</p>
        </div>
        <MoveList moves={steps.slice(1).map((s) => s.san)} active={ply - 1} onSelect={(p) => go(p + 1)} marks={an.marks.slice(0, -1)} />
        <ShareButton gameId={gameId} cur={cur} last={last} />
        <p className="mt-2 text-[11px] text-muted">
          Déplace les pièces pour essayer tes propres coups : {ENGINE_NAME} les évalue. Flèches ← → du clavier pour avancer coup par coup, F pour retourner l'échiquier.
          {an.on ? " Flèche bleue : meilleur coup du moteur ; flèche orange/rouge : le coup joué, quand c'est une erreur." : ""}
        </p>
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

const VERDICT: Record<string, string> = {
  ok: "bon coup, le moteur ne perd rien.",
  "?!": "imprécision.",
  "?": "erreur.",
  "??": "gaffe.",
};

/** Un pion qui atteint la dernière rangée (la promotion est choisie par le dialogue du plateau). */
function isPromotionMove(fen: string, from: string, to: string): boolean {
  const c = new Chess(fen);
  const p = c.get(from as Square);
  return !!p && p.type === "p" && (to[1] === "8" || to[1] === "1");
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
 * puis la position affichée (partie ou variante du joueur) est approfondie. `marks[i]` annote le coup joué DEPUIS la position i.
 */
function useAnalysis(fens: string[], ply: number, viewFen: string, prevFen: string | null) {
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const [evals, setEvals] = useState<Array<Score | null>>([]);
  const [progress, setProgress] = useState(0);
  const [line, setLine] = useState<EngineLine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  /** meilleure ligne connue par position (analyses approfondies), pour juger les coups des variantes */
  const deep = useRef(new Map<string, EngineLine>());
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
          if (l && !deep.current.has(fens[i]!)) deep.current.set(fens[i]!, l);
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
    if (!engine || progress < 1 || !viewFen) return;
    setLine(deep.current.get(viewFen) ?? null);
    let live = true;
    const keep = (fen: string, l: EngineLine) => {
      const known = deep.current.get(fen);
      if (!known || l.depth >= known.depth) deep.current.set(fen, l);
    };
    (async () => {
      // pour juger un coup de variante, la position d'avant doit être connue à la même profondeur
      if (prevFen && !terminalScore(prevFen) && (deep.current.get(prevFen)?.depth ?? 0) < JUDGE_DEPTH) {
        const l = await engine.analyse(prevFen, JUDGE_DEPTH);
        if (!live) return;
        if (l) keep(prevFen, l);
      }
      await engine.analyse(viewFen, LIVE_DEPTH, (l) => {
        if (!live) return;
        setLine(l);
        keep(viewFen, l);
      });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, progress >= 1, viewFen, prevFen, key]);

  const cps = evals.map((e) => (e ? scoreToCp(e) : 0));
  const marks: MoveMark[] = fens.map(() => null);
  // le premier coup de la position i est joué par le trait de la position i
  const turnOf = (i: number) => (fens[i]?.split(" ")[1] === "b" ? "b" : "w");
  for (let i = 0; i + 1 < fens.length; i++) {
    if (evals[i] && evals[i + 1]) marks[i] = classify(cps[i]!, cps[i + 1]!, turnOf(i));
  }
  const scoreAt = (p: number): Score | null => (p === ply && line && progress >= 1 ? line.score : evals[p] ?? null);
  const terminal = viewFen ? terminalScore(viewFen) : null;
  const mainIdx = fens.indexOf(viewFen);
  const viewScore: Score | null = terminal ?? (line && progress >= 1 ? line.score : mainIdx >= 0 ? evals[mainIdx] ?? null : null);

  /** Jugement d'un coup de variante : perte de chances de gain entre la position de départ et celle d'arrivée. */
  const judge = (fromFen: string, to: { fen: string; uci: string | null }) => {
    const fromLine = deep.current.get(fromFen);
    const before = terminalScore(fromFen) ?? (fromLine && fromLine.depth >= JUDGE_DEPTH ? fromLine.score : null);
    const afterLine = to.fen === viewFen ? line : deep.current.get(to.fen) ?? null;
    const after = terminalScore(to.fen) ?? (afterLine && afterLine.depth >= JUDGE_DEPTH ? afterLine.score : null);
    if (!before || !after) return { pending: true as const, mark: null, best: null };
    const mover = fromFen.split(" ")[1] === "b" ? "b" : "w";
    const mark = classify(scoreToCp(before), scoreToCp(after), mover);
    const bestUci = deep.current.get(fromFen)?.pv[0];
    const best = bestUci && bestUci !== to.uci ? pvToSan(fromFen, [bestUci], 1)[0] ?? null : null;
    return { pending: false as const, mark, best };
  };

  return { on, failed, start, progress: engine ? progress : 0, evals: cps, marks, line, scoreAt, viewScore, judge };
}

/** Profondeur minimale avant de juger un coup de variante (évite un verdict sur une évaluation trop superficielle). */
const JUDGE_DEPTH = 14;

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

/** Partager l'analyse : lien vers la partie, à la position affichée (et avec la variante en cours). */
function ShareButton({ gameId, cur, last }: { gameId: string; cur: Cursor; last: number }) {
  const [done, setDone] = useState<string | null>(null);
  const share = async () => {
    const q = new URLSearchParams();
    if (cur.variation) {
      q.set("ply", String(cur.variation.base));
      q.set("v", cur.variation.steps.slice(0, cur.vply).map((x) => x.uci).join(","));
    } else if (cur.ply !== last) q.set("ply", String(cur.ply));
    const url = `${window.location.origin}/partie/${gameId}${q.size ? `?${q}` : ""}`;
    try {
      if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) { await navigator.share({ title: "Analyse de partie", url }); setDone("Partagé ✓"); }
      else { await navigator.clipboard.writeText(url); setDone("Lien copié ✓"); }
    } catch { setDone(url); }
    setTimeout(() => setDone(null), 4000);
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void share()} className="rounded-lg border border-neon/50 px-3 py-1.5 text-sm font-semibold text-neon hover:bg-neon/10">
        🔗 Partager cette analyse
      </button>
      {done && <span role="status" className="break-all text-xs text-muted">{done}</span>}
      <span className="text-[11px] text-muted">Le lien ouvre la partie à cette position{cur.variation ? ", avec ta variante" : ""}.</span>
    </div>
  );
}
