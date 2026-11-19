"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GameBoard } from "./GameBoard";
import { FlipButton } from "./SiteNav";
import { useSettings } from "../lib/settings";
import { moveSound, sound } from "../lib/sound";
import {
  accuracyOf, classify, Engine, ENGINE_NAME, formatScore, pvToSan, scoreToCp, terminalScore, winPct,
  type EngineLine, type MoveMark, type Score,
} from "../lib/engine";
import {
  addMove, addUcis, allNodes, branchPoint, isMainline, legalMove, lineEnd, loadTree, mainline, moveNumber, pathTo,
  promote, remove, saveTree, toPgn, type SavedTree, type Tree,
} from "../lib/tree";

/** Passe rapide (toutes les positions) puis analyse approfondie de la position affichée. */
const PASS_DEPTH = 12;
const LIVE_DEPTH = 24;
const PREF_KEY = "arena.analysis.prefs";

export interface AnalysisCtx {
  tree: Tree;
  nodeId: string;
  fen: string;
  /** demi-coup de la partie si la position affichée est un coup de la partie, sinon null */
  gamePly: number | null;
  flipped: boolean;
}

interface Props {
  initialTree: Tree;
  initialNode?: string;
  /** position affichée par défaut s'il n'y a pas d'analyse sauvegardée (ex. fin de la partie) */
  defaultNode?: string;
  /** coups de la partie (UCI) : ils ne peuvent être ni supprimés ni remplacés comme ligne principale */
  gameUcis?: readonly string[];
  /** orientation par défaut */
  orientation?: "w" | "b";
  /** sauvegarde locale de l'arbre (variantes conservées d'une visite à l'autre) */
  storageKey?: string;
  /** moteur allumé dès l'ouverture */
  engineOnOpen?: boolean;
  /** noms des joueurs (bilan de précision) */
  names?: { w: string; b: string };
  /** cartes des joueurs autour de l'échiquier */
  cardTop?: (c: AnalysisCtx) => ReactNode;
  cardBottom?: (c: AnalysisCtx) => ReactNode;
  /** panneau sous la liste des coups (résultat, partage…) */
  footer?: (c: AnalysisCtx) => ReactNode;
  /** mise en page deux colonnes sur grand écran */
  wide?: boolean;
  /** clé qui force la réinitialisation (nouvelle position importée) */
  resetKey?: string | number;
}

function readPrefs(): { engine: boolean; lines: number } {
  try { const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as { engine?: unknown; lines?: unknown }; return { engine: v.engine !== false, lines: typeof v.lines === "number" && v.lines >= 1 && v.lines <= 5 ? v.lines : 3 }; }
  catch { return { engine: true, lines: 3 }; }
}

/**
 * Tableau d'analyse complet : on joue librement les deux camps, chaque coup crée une variante (sans limite,
 * variantes dans les variantes), Stockfish donne plusieurs suites, évalue chaque coup de l'arbre et annote les erreurs.
 */
export function AnalysisBoard(p: Props) {
  const [settings] = useSettings();
  const [tree, setTree] = useState<Tree>(p.initialTree);
  const [node, setNode] = useState<string>(p.initialNode ?? p.defaultNode ?? p.initialTree.root);
  const [flipped, setFlipped] = useState(false);

  // nouvelle partie / position importée
  useEffect(() => {
    let t = p.initialTree; let n = p.initialNode ?? p.defaultNode ?? p.initialTree.root;
    if (p.storageKey && !p.initialNode) {
      try {
        const saved = loadTree(JSON.parse(localStorage.getItem(p.storageKey) ?? "null") as SavedTree);
        // une partie : la sauvegarde doit contenir les coups de la partie (sinon on repart de la partie)
        if (saved && saved.tree.nodes[saved.tree.root]!.fen === t.nodes[t.root]!.fen) {
          const main = mainline(saved.tree).slice(1).map((id) => saved.tree.nodes[id]!.uci);
          if (!p.gameUcis || p.gameUcis.every((u, i) => main[i] === u)) { t = saved.tree; n = saved.current; }
        }
      } catch { /* sauvegarde illisible : ignorée */ }
    }
    setTree(t); setNode(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.resetKey]);

  // sauvegarde locale (best-effort)
  useEffect(() => {
    if (!p.storageKey) return;
    const t = setTimeout(() => { try { localStorage.setItem(p.storageKey!, JSON.stringify(saveTree(tree, node))); } catch { /* plein ou indisponible */ } }, 400);
    return () => clearTimeout(t);
  }, [tree, node, p.storageKey]);

  // coups de la partie dans l'arbre
  const gameIds = useMemo(() => {
    const ids = new Set<string>();
    if (!p.gameUcis) return ids;
    let cur = tree.root;
    for (const u of p.gameUcis) {
      const next = tree.nodes[cur]!.children.find((c) => tree.nodes[c]!.uci === u);
      if (!next) break;
      ids.add(next); cur = next;
    }
    return ids;
  }, [tree, p.gameUcis]);

  const n = tree.nodes[node] ?? tree.nodes[tree.root]!;
  const fen = n.fen;
  const ctx: AnalysisCtx = { tree, nodeId: n.id, fen, gamePly: n.id === tree.root || gameIds.has(n.id) ? n.ply : null, flipped };

  const startRef = useRef<() => void>(() => {});
  const play = useCallback((from: string, to: string, promotion?: string) => {
    const m = legalMove(fen, from, to, promotion);
    if (!m) return false;
    sound.play(moveSound(m));
    if (p.gameUcis) startRef.current(); // partie : essayer un coup lance le moteur pour le juger
    const r = addMove(tree, n.id, m);
    setTree(r.tree); setNode(r.id);
    return true;
  }, [fen, tree, n.id, p.gameUcis]);

  const playLine = useCallback((ucis: string[]) => {
    const r = addUcis(tree, n.id, ucis);
    setTree(r.tree); setNode(r.id);
  }, [tree, n.id]);

  // navigation : ← ↑ → ↓ (et Début / Fin)
  const goPrev = useCallback(() => { if (n.parent) setNode(n.parent); }, [n.parent]);
  const goNext = useCallback(() => { const c = n.children[0]; if (c) setNode(c); }, [n.children]);
  const goStart = useCallback(() => setNode(tree.root), [tree.root]);
  const goEnd = useCallback(() => setNode(lineEnd(tree, n.id)), [tree, n.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowUp" || e.key === "Home") goStart();
      else if (e.key === "ArrowDown" || e.key === "End") goEnd();
      else if (e.key === "f" || e.key === "F") setFlipped((f) => !f);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, goStart, goEnd]);

  const an = useTreeAnalysis(tree, n.id, p.engineOnOpen ?? readPrefs().engine);
  const marks = an.marks;
  startRef.current = () => { if (!an.on) an.start(); };
  // partie : dès que le moteur est allumé, chaque coup de la partie est évalué (annotations, courbe, précision)
  const didMain = useRef(false);
  useEffect(() => {
    if (an.on && p.gameUcis && !didMain.current) { didMain.current = true; an.analyseMain(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [an.on]);

  // flèches : meilleures suites du moteur, et le coup joué quand c'est une erreur
  const arrows: Array<{ from: string; to: string; color?: string }> = [];
  if (an.on && !an.failed) {
    an.lines.forEach((l, i) => {
      const u = l.pv[0];
      if (u) arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: i === 0 ? "#22d3ee" : i === 1 ? "#22d3ee99" : "#22d3ee55" });
    });
    const next = n.children[0];
    const mk = next ? marks.get(next) : null;
    const nu = next ? tree.nodes[next]!.uci : null;
    if (mk && nu && nu !== an.lines[0]?.pv[0]) arrows.push({ from: nu.slice(0, 2), to: nu.slice(2, 4), color: mk === "??" ? "#ef4444" : mk === "?" ? "#fb923c" : "#eab308" });
  }

  const baseOrient = p.orientation ?? "w";
  const orientation = flipped ? (baseOrient === "w" ? "b" : "w") : baseOrient;
  const toMove = fen.split(" ")[1] === "b" ? "b" : "w";
  const locked = gameIds.has(n.id);
  const inVariation = !isMainline(tree, n.id);
  const bp = branchPoint(tree, n.id);
  const canPromote = inVariation && !!bp && !gameIds.has(tree.nodes[tree.nodes[bp]!.parent!]!.children[0]!);
  const thisMark = marks.get(n.id);
  const bestBefore = n.parent ? an.evalOf(tree.nodes[n.parent]!.fen) : null;
  const bestSan = thisMark && bestBefore?.pv[0] && bestBefore.pv[0] !== n.uci ? pvToSan(tree.nodes[n.parent!]!.fen, [bestBefore.pv[0]], 1)[0] : null;

  const boardCol = (
    <div className="flex w-full flex-col gap-1.5">
      {p.cardTop?.(ctx)}
      {an.on && <EvalBar score={an.viewScore} flip={orientation === "b"} />}
      <GameBoard
        fen={fen} serverFen={fen} orientation={orientation} myColor={toMove} interactive myTurn
        lastMove={n.uci} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette}
        autoQueen={settings.autoQueen} coordinates={settings.coordinates}
        onMove={play} onCancelPremoves={() => {}} arrows={arrows}
      />
      {p.cardBottom?.(ctx)}
      <div className="flex gap-1.5">
        <NavBtn label="Début" onClick={goStart} disabled={!n.parent}>⏮</NavBtn>
        <NavBtn label="Coup précédent" onClick={goPrev} disabled={!n.parent}>◀</NavBtn>
        <NavBtn label="Coup suivant" onClick={goNext} disabled={!n.children.length}>▶</NavBtn>
        <NavBtn label="Fin de la ligne" onClick={goEnd} disabled={!n.children.length}>⏭</NavBtn>
        <FlipButton onFlip={() => setFlipped((f) => !f)} className="!px-3 text-lg" />
      </div>
    </div>
  );

  const side = (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <EnginePanel an={an} fen={fen} onPlayLine={playLine} />

      <div className="panel p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="flex-1 text-sm font-semibold">Coups et variantes</p>
          {n.parent && (
            <>
              {canPromote && <button type="button" onClick={() => setTree(promote(tree, n.id))} className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs text-muted hover:text-text" title="Cette variante devient la suite principale">⬆ Remonter la variante</button>}
              {!locked && <button type="button" onClick={() => { const r = remove(tree, n.id); setTree(r.tree); setNode(r.id); }} className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs text-muted hover:text-danger" title="Supprime ce coup et tout ce qui suit">🗑 Supprimer à partir d'ici</button>}
            </>
          )}
        </div>
        {thisMark !== undefined && n.san && (
          <p className={`mb-2 text-sm ${thisMark === "??" ? "text-danger" : thisMark === "?" ? "text-[#fb923c]" : thisMark === "?!" ? "text-gold" : "text-win"}`}>
            <span className="font-semibold">{moveNumber(tree.nodes[n.parent!]!.fen, true)}{n.san}{thisMark ?? ""}</span> — {VERDICT[thisMark ?? "ok"]}
            {bestSan && <span className="text-muted"> Le meilleur était {bestSan}.</span>}
          </p>
        )}
        <MoveTree tree={tree} current={n.id} onPick={setNode} marks={marks} gameIds={gameIds} />
        <p className="mt-2 text-[11px] text-muted">
          Déplace les pièces des deux camps : chaque coup crée une variante (même à l'intérieur d'une variante). Clique un coup pour y aller.
          Clavier : ← → coup par coup, ↑ ↓ début et fin, F pour retourner l'échiquier.
        </p>
      </div>

      {an.on && an.mainReady && (
        <div className="panel flex flex-col gap-2 p-3">
          <p className="text-sm font-semibold">{p.gameUcis ? "Bilan de la partie" : "Bilan de la ligne principale"}</p>
          <EvalGraph tree={tree} an={an} current={n.id} onPick={setNode} />
          <Summary tree={tree} marks={marks} an={an} names={p.names ?? { w: "Blancs", b: "Noirs" }} />
        </div>
      )}

      {p.footer?.(ctx)}
      <ExportPanel tree={tree} fen={fen} />
      {an.on && (
        <p className="px-1 text-[11px] text-muted/70">
          Moteur {ENGINE_NAME} (stockfish.js, licence GPLv3 — <a className="underline" href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noreferrer">code source</a>) exécuté dans ton navigateur : rien n'est envoyé au serveur.
        </p>
      )}
    </div>
  );

  if (p.wide) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <div className="mx-auto w-full" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 270px)))" }}>{boardCol}</div>
        {side}
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full flex-col gap-3" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 220px)))" }}>
      {boardCol}
      {side}
    </div>
  );
}

const VERDICT: Record<string, string> = { ok: "bon coup, le moteur ne perd rien.", "?!": "imprécision.", "?": "erreur.", "??": "gaffe." };

function NavBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <button type="button" className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-lg text-muted hover:text-text disabled:opacity-30" onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}

// ─── Moteur ──────────────────────────────────────────────────────────────────

type Analysis = ReturnType<typeof useTreeAnalysis>;

/**
 * Stockfish sur tout l'arbre : chaque position visitée est approfondie (plusieurs suites),
 * « Analyser tous les coups » évalue chaque position de l'arbre (variantes comprises) pour annoter tous les coups.
 */
function useTreeAnalysis(tree: Tree, nodeId: string, autoStart: boolean) {
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [multiPv, setMultiPv] = useState(3);
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [pass, setPass] = useState<{ done: number; total: number } | null>(null);
  const [, bump] = useState(0);
  /** meilleure ligne connue par position (FEN) */
  const evals = useRef(new Map<string, EngineLine>());
  const keep = useCallback((fen: string, l: EngineLine) => {
    const k = evals.current.get(fen);
    if (!k || l.depth >= k.depth) evals.current.set(fen, l);
  }, []);

  useEffect(() => { setMultiPv(readPrefs().lines); }, []);
  useEffect(() => () => engine?.terminate(), [engine]);

  const start = useCallback(() => {
    setOn(true);
    try { setEngine((e) => e ?? new Engine()); } catch { setFailed(true); }
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), engine: true })); } catch { /* best-effort */ }
  }, []);
  const stop = useCallback(() => {
    setOn(false); setPass(null); setLines([]);
    setEngine((e) => { e?.terminate(); return null; });
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), engine: false })); } catch { /* best-effort */ }
  }, []);
  const changeLines = useCallback((k: number) => {
    setMultiPv(k);
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), lines: k })); } catch { /* best-effort */ }
  }, []);
  useEffect(() => { if (autoStart) start(); }, [autoStart, start]);

  const fen = tree.nodes[nodeId]?.fen ?? "";
  const parentFen = tree.nodes[nodeId]?.parent ? tree.nodes[tree.nodes[nodeId]!.parent!]!.fen : null;

  /** passe : évalue toutes les positions indiquées qui ne le sont pas encore assez */
  const runPass = useCallback((fens: string[]) => {
    const todo = [...new Set(fens)].filter((f) => !terminalScore(f) && (evals.current.get(f)?.depth ?? 0) < PASS_DEPTH);
    if (!todo.length) return;
    setPass({ done: 0, total: todo.length });
  }, []);
  const passFens = useRef<string[]>([]);
  const analyseAll = useCallback(() => {
    const fens = allNodes(tree).map((id) => tree.nodes[id]!.fen);
    passFens.current = fens;
    runPass(fens);
  }, [tree, runPass]);
  const analyseMain = useCallback(() => {
    const fens = mainline(tree).map((id) => tree.nodes[id]!.fen);
    passFens.current = fens;
    runPass(fens);
  }, [tree, runPass]);

  // passe en cours
  const passing = pass !== null;
  useEffect(() => {
    if (!engine || !passing) return;
    let live = true;
    (async () => {
      const todo = [...new Set(passFens.current)].filter((f) => !terminalScore(f) && (evals.current.get(f)?.depth ?? 0) < PASS_DEPTH);
      setPass({ done: 0, total: todo.length });
      for (let i = 0; i < todo.length; i++) {
        if (!live) return;
        const l = await engine.analyse(todo[i]!, PASS_DEPTH);
        if (!live) return;
        if (l) keep(todo[i]!, l);
        setPass({ done: i + 1, total: todo.length });
        if (i % 3 === 2) bump((x) => x + 1);
      }
      bump((x) => x + 1);
      setPass(null);
    })().catch(() => setFailed(true));
    return () => { live = false; engine.stop(); };
  }, [engine, passing, keep]);

  // position affichée : plusieurs suites, en profondeur (après la passe)
  useEffect(() => {
    if (!engine || passing || !fen) return;
    const known = evals.current.get(fen);
    setLines(known ? [known] : []);
    if (terminalScore(fen)) { setLines([]); return; }
    let live = true;
    (async () => {
      // pour annoter le coup affiché, la position d'avant doit être évaluée
      if (parentFen && !terminalScore(parentFen) && (evals.current.get(parentFen)?.depth ?? 0) < PASS_DEPTH) {
        const l = await engine.analyse(parentFen, PASS_DEPTH);
        if (!live) return;
        if (l) { keep(parentFen, l); bump((x) => x + 1); }
      }
      let lastDepth = 0;
      await engine.analyseLines(fen, LIVE_DEPTH, multiPv, (ls) => {
        if (!live || !ls[0]) return;
        setLines(ls);
        keep(fen, ls[0]);
        if (ls[0].depth !== lastDepth && (ls[0].depth === PASS_DEPTH || ls[0].depth % 4 === 0)) { lastDepth = ls[0].depth; bump((x) => x + 1); }
      });
      if (live) bump((x) => x + 1);
    })().catch(() => setFailed(true));
    return () => { live = false; };
  }, [engine, passing, fen, parentFen, multiPv, keep]);

  const evalOf = useCallback((f: string): EngineLine | null => evals.current.get(f) ?? null, []);
  const scoreOf = (f: string): Score | null => {
    const t = terminalScore(f);
    if (t) return t;
    const l = evals.current.get(f);
    return l && l.depth >= PASS_DEPTH ? l.score : null;
  };

  // annotations de TOUS les coups de l'arbre dont les deux positions sont évaluées
  const marks = new Map<string, MoveMark>();
  for (const id of Object.keys(tree.nodes)) {
    const nd = tree.nodes[id]!;
    if (!nd.parent) continue;
    const pf = tree.nodes[nd.parent]!.fen;
    const a = scoreOf(pf); const b = scoreOf(nd.fen);
    if (a && b) marks.set(id, classify(scoreToCp(a), scoreToCp(b), pf.split(" ")[1] === "b" ? "b" : "w"));
  }
  const main = mainline(tree);
  const mainReady = main.length > 1 && main.every((id) => scoreOf(tree.nodes[id]!.fen) !== null);
  const unevaluated = Object.values(tree.nodes).filter((x) => scoreOf(x.fen) === null).length;
  const terminal = fen ? terminalScore(fen) : null;
  const viewScore: Score | null = terminal ?? (lines[0]?.score ?? evals.current.get(fen)?.score ?? null);

  return {
    on, failed, start, stop, multiPv, changeLines, lines, viewScore, pass, analyseAll, analyseMain,
    marks, mainReady, unevaluated, evalOf, scoreOf, depth: lines[0]?.depth ?? 0,
  };
}

function EnginePanel({ an, fen, onPlayLine }: { an: Analysis; fen: string; onPlayLine: (ucis: string[]) => void }) {
  if (!an.on) {
    return (
      <div className="panel p-3">
        <button type="button" onClick={an.start} className="neon-btn w-full rounded-lg px-3 py-2.5 font-semibold">Analyser avec {ENGINE_NAME}</button>
      </div>
    );
  }
  if (an.failed) return <p className="panel p-3 text-sm text-danger">Le moteur n'a pas pu démarrer sur ce navigateur.</p>;
  const terminal = terminalScore(fen);
  return (
    <div className="panel flex flex-col gap-2 p-3" aria-label="Moteur">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">
          <span className="text-neon">{ENGINE_NAME}</span>
          {an.viewScore && <span className="tabular ml-2 font-display text-lg">{formatScore(an.viewScore)}</span>}
        </p>
        <span className="tabular text-xs text-muted">{an.pass ? "" : an.depth ? `profondeur ${an.depth}` : terminal ? "partie terminée" : "calcul…"}</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted">
          <label htmlFor="mpv">Suites</label>
          <select id="mpv" value={an.multiPv} onChange={(e) => an.changeLines(Number(e.target.value))} className="rounded border border-line bg-surface-2 px-1 py-0.5">
            {[1, 2, 3, 4, 5].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button type="button" onClick={an.stop} className="ml-1 rounded bg-surface-2 px-2 py-0.5 hover:text-text" title="Éteindre le moteur">Éteindre</button>
        </span>
      </div>
      {an.pass ? (
        <div>
          <p className="tabular mb-1 text-xs text-muted">Analyse de chaque coup… {an.pass.done} / {an.pass.total}</p>
          <div className="h-1 overflow-hidden rounded bg-surface-2"><div className="h-full bg-neon transition-all" style={{ width: `${an.pass.total ? (an.pass.done / an.pass.total) * 100 : 0}%` }} /></div>
        </div>
      ) : (
        <ol className="flex flex-col gap-1" aria-label="Meilleures suites">
          {an.lines.map((l, i) => <PvLine key={i} fen={fen} line={l} onPlay={onPlayLine} />)}
        </ol>
      )}
      {!an.pass && an.unevaluated > 0 && (
        <button type="button" onClick={an.analyseAll} className="self-start rounded-lg border border-neon/50 px-3 py-1.5 text-xs font-semibold text-neon hover:bg-neon/10">
          Analyser tous les coups, variantes comprises ({an.unevaluated} position{an.unevaluated > 1 ? "s" : ""})
        </button>
      )}
    </div>
  );
}

/** Une suite du moteur : score + coups cliquables (clic = jouer la suite jusqu'à ce coup). */
function PvLine({ fen, line, onPlay }: { fen: string; line: EngineLine; onPlay: (ucis: string[]) => void }) {
  const sans = pvToSan(fen, line.pv, 12);
  const [, turn, , , , full] = fen.split(" ");
  let num = Number(full); let black = turn === "b";
  return (
    <li className="flex gap-2 text-sm leading-snug">
      <span className="tabular w-12 shrink-0 font-semibold">{formatScore(line.score)}</span>
      <span className="min-w-0 flex-1">
        {sans.map((san, i) => {
          const pre = !black ? `${num}. ` : i === 0 ? `${num}… ` : "";
          if (black) num++;
          black = !black;
          return (
            <button key={i} type="button" onClick={() => onPlay(line.pv.slice(0, i + 1))}
              className={`rounded px-0.5 hover:bg-surface-2 ${i === 0 ? "font-semibold" : "text-muted"}`}>{pre}{san}</button>
          );
        })}
      </span>
    </li>
  );
}

// ─── Arbre des coups ─────────────────────────────────────────────────────────

const MARK_CLS: Record<string, string> = { "??": "text-danger", "?": "text-[#fb923c]", "?!": "text-gold" };

/**
 * Coups et variantes : la ligne principale en gras, chaque variante en dessous (indentée),
 * les sous-variantes entre parenthèses — comme sur Lichess.
 */
function MoveTree({ tree, current, onPick, marks, gameIds }: {
  tree: Tree; current: string; onPick: (id: string) => void; marks: Map<string, MoveMark>; gameIds: Set<string>;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-node="${current}"]`);
    const b = box.current;
    if (!el || !b) return;
    const top = el.offsetTop - b.offsetTop;
    if (top < b.scrollTop || top > b.scrollTop + b.clientHeight - el.offsetHeight) b.scrollTop = top - b.clientHeight / 2;
  }, [current]);

  const move = (id: string, force: boolean, main: boolean) => {
    const nd = tree.nodes[id]!;
    const mk = marks.get(id);
    return (
      <button key={id} type="button" data-node={id} onClick={() => onPick(id)}
        className={`rounded px-1 py-0.5 ${id === current ? "bg-neon/20 text-neon" : "hover:bg-surface-2"} ${main ? "font-semibold" : ""} ${gameIds.size && !gameIds.has(id) && main ? "italic" : ""}`}>
        <span className="text-muted">{moveNumber(tree.nodes[nd.parent!]!.fen, force)}</span>{nd.san}
        {mk && <span className={`ml-0.5 font-bold ${MARK_CLS[mk]}`}>{mk}</span>}
      </button>
    );
  };

  /** suite d'un nœud : la 1re suite, ses alternatives, puis la continuation */
  const inline = (parentId: string, force: boolean, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let pid = parentId; let f = force;
    for (;;) {
      const par = tree.nodes[pid]!;
      if (!par.children.length) break;
      const [first, ...vars] = par.children;
      out.push(move(first!, f, false));
      for (const v of vars) {
        out.push(
          <span key={`v${v}`} className="text-muted">
            ({move(v, true, false)}{inline(v, false, depth + 1)})
          </span>,
        );
      }
      f = vars.length > 0;
      pid = first!;
      if (depth > 40) break;
    }
    return out;
  };

  const rows: ReactNode[] = [];
  let pid = tree.root; let force = true;
  for (;;) {
    const par = tree.nodes[pid]!;
    if (!par.children.length) break;
    const [first, ...vars] = par.children;
    rows.push(move(first!, force, true));
    if (vars.length) {
      rows.push(
        <div key={`b${pid}`} className="my-1 ml-2 flex w-full flex-col gap-0.5 border-l-2 border-line pl-2 text-[13px]">
          {vars.map((v) => (
            <div key={v} className="flex flex-wrap items-baseline">{move(v, true, false)}{inline(v, false, 1)}</div>
          ))}
        </div>,
      );
    }
    force = vars.length > 0;
    pid = first!;
  }
  if (!rows.length) return <p className="px-1 text-sm text-muted">Aucun coup : joue un coup sur l'échiquier pour commencer.</p>;
  return (
    <div ref={box} className="flex max-h-72 flex-wrap content-start items-baseline overflow-y-auto text-sm lg:max-h-[42vh]">
      {rows.map((r, i) => <Fragment key={i}>{r}</Fragment>)}
    </div>
  );
}

// ─── Bilan ───────────────────────────────────────────────────────────────────

function EvalBar({ score, flip }: { score: Score | null; flip: boolean }) {
  const w = score ? winPct(scoreToCp(score)) : 50;
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-[#1C2233] ring-1 ring-line" aria-label="Barre d'évaluation">
      <div className="absolute inset-y-0 bg-[#E7ECF3] transition-all duration-300" style={flip ? { right: 0, width: `${w}%` } : { left: 0, width: `${w}%` }} />
      <div className="absolute inset-y-0 left-1/2 w-px bg-neon/60" />
    </div>
  );
}

/** Courbe des chances de gain des Blancs sur la ligne principale, cliquable. */
function EvalGraph({ tree, an, current, onPick }: { tree: Tree; an: Analysis; current: string; onPick: (id: string) => void }) {
  const ids = mainline(tree);
  const cps = ids.map((id) => { const s = an.scoreOf(tree.nodes[id]!.fen); return s ? scoreToCp(s) : 0; });
  const nmax = Math.max(1, ids.length - 1);
  const pts = cps.map((cp, i) => `${(i / nmax) * 100},${100 - winPct(cp)}`).join(" ");
  const curIdx = ids.indexOf(pathTo(tree, current).filter((x) => ids.includes(x)).at(-1) ?? tree.root);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-16 w-full cursor-pointer rounded bg-[#1C2233]"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width) * nmax); onPick(ids[Math.max(0, Math.min(ids.length - 1, i))]!); }}
      role="img" aria-label="Courbe d'évaluation">
      <polygon points={`0,100 ${pts} 100,100`} fill="#E7ECF3" opacity={0.85} />
      <line x1="0" y1="50" x2="100" y2="50" stroke="#22d3ee" strokeOpacity={0.4} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      <line x1={(curIdx / nmax) * 100} y1="0" x2={(curIdx / nmax) * 100} y2="100" stroke="#22d3ee" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Précision et imprécisions / erreurs / gaffes de chaque camp sur la ligne principale. */
function Summary({ tree, marks, an, names }: { tree: Tree; marks: Map<string, MoveMark>; an: Analysis; names: { w: string; b: string } }) {
  const ids = mainline(tree).slice(1);
  const row = (c: "w" | "b") => {
    const mine = ids.filter((id) => tree.nodes[tree.nodes[id]!.parent!]!.fen.split(" ")[1] === c);
    const count = (k: MoveMark) => mine.filter((id) => marks.get(id) === k).length;
    const acc = accuracyOf(mine.flatMap((id) => {
      const a = an.scoreOf(tree.nodes[tree.nodes[id]!.parent!]!.fen); const b = an.scoreOf(tree.nodes[id]!.fen);
      return a && b ? [{ before: scoreToCp(a), after: scoreToCp(b), mover: c }] : [];
    }));
    return (
      <tr key={c}>
        <td className="truncate py-1 pr-2 font-medium">{names[c]}</td>
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
      <tbody>{row("w")}{row("b")}</tbody>
    </table>
  );
}

/** Copier le PGN (avec toutes les variantes) ou la FEN de la position affichée. */
function ExportPanel({ tree, fen }: { tree: Tree; fen: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setMsg(`${what} copié ✓`); }
    catch { setMsg(text); }
    setTimeout(() => setMsg(null), 5000);
  };
  const download = () => {
    const blob = new Blob([toPgn(tree)], { type: "application/x-chess-pgn" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `analyse-${new Date().toISOString().slice(0, 10)}.pgn`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="panel flex flex-wrap items-center gap-2 p-3 text-xs">
      <span className="font-semibold text-muted">Exporter :</span>
      <button type="button" onClick={() => void copy(toPgn(tree), "PGN")} className="rounded-lg bg-surface-2 px-2.5 py-1.5 hover:text-text">Copier le PGN (avec variantes)</button>
      <button type="button" onClick={download} className="rounded-lg bg-surface-2 px-2.5 py-1.5 hover:text-text">Télécharger .pgn</button>
      <button type="button" onClick={() => void copy(fen, "FEN")} className="rounded-lg bg-surface-2 px-2.5 py-1.5 hover:text-text">Copier la FEN</button>
      {msg && <span role="status" className="w-full break-all text-muted">{msg}</span>}
    </div>
  );
}
