"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Color, RepertoireResponse } from "@chessarena/shared";
import { GameBoard } from "../../components/GameBoard";
import { useSettings } from "../../lib/settings";
import { Engine, ENGINE_NAME, pvToSan, scoreToCp, terminalScore, winPct } from "../../lib/engine";
import {
  ACCEPT_LOSS, asDoc, buildTree, emptyDoc, exportPgn, fenKey, isDue, judge, lineLabel, pathsTo, playUci, positionsToAnalyse,
  repertoireMove, review, START, syncCards, turnOf, type Card, type RepertoireDoc, type Tree,
} from "../../lib/repertoire";

const ANALYSIS_DEPTH = 14;
const MARK_CLS: Record<string, string> = { "??": "text-danger", "?": "text-[#fb923c]", "?!": "text-gold" };
const COLOR_NAME = { w: "Blancs", b: "Noirs" } as const;

/**
 * Répertoire d'ouvertures construit à partir des parties du joueur, erreurs récurrentes repérées par
 * Stockfish 19, exercices « trouve le meilleur coup » qui corrigent le répertoire, export PGN (ChessBase).
 */
export default function RepertoirePage() {
  const router = useRouter();
  const [me, setMe] = useState<string | null>(null);
  const [resp, setResp] = useState<RepertoireResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doc, setDoc] = useState<RepertoireDoc>(emptyDoc);
  const [color, setColor] = useState<Color>("w");
  const [mode, setMode] = useState<"tree" | "train">("tree");
  const [trainKey, setTrainKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const engineRef = useRef<Engine | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    const back = () => router.replace(`/?next=${encodeURIComponent("/repertoire")}`);
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMe(((await r.json()) as { userId: string }).userId) : back()))
      .catch(back);
  }, [router]);

  useEffect(() => {
    if (!me) return;
    fetch("/api/repertoire", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 503 ? "db" : "net");
        const d = (await r.json()) as RepertoireResponse;
        setResp(d);
        setDoc(asDoc(d.data));
        // couleur par défaut : celle avec le plus de parties
        const w = d.games.filter((g) => g.color === "w").length;
        setColor(w >= d.games.length - w ? "w" : "b");
      })
      .catch((e: Error) => setLoadError(e.message === "db"
        ? "Le répertoire nécessite la base de données du serveur."
        : "Impossible de charger tes parties (le serveur se réveille peut-être : réessaie dans une minute)."));
  }, [me]);

  useEffect(() => () => engineRef.current?.terminate(), []);
  const engine = useCallback(() => (engineRef.current ??= new Engine()), []);

  const trees = useMemo(() => ({
    w: buildTree(resp?.games ?? [], "w"),
    b: buildTree(resp?.games ?? [], "b"),
  }), [resp]);
  const tree = trees[color];
  const paths = useMemo(() => ({ w: pathsTo(trees.w), b: pathsTo(trees.b) }), [trees]);

  // ─── Enregistrement (différé) ───────────────────────────────────────────────
  const update = useCallback((f: (d: RepertoireDoc) => RepertoireDoc) => { dirty.current = true; setDoc(f); }, []);
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      setSaveState("saving");
      fetch("/api/repertoire", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: doc }) })
        .then((r) => setSaveState(r.ok ? "saved" : "error"))
        .catch(() => setSaveState("error"));
    }, 800);
    return () => clearTimeout(t);
  }, [doc]);

  // ─── Analyse Stockfish des positions du répertoire (automatique, en cache) ──
  const pending = useMemo(() => [...positionsToAnalyse(trees.w, doc), ...positionsToAnalyse(trees.b, doc)], [trees, doc]);
  const running = useRef(false);
  const analyse = useCallback(async () => {
    if (running.current || !resp) return;
    running.current = true;
    const todo = [...positionsToAnalyse(trees.w, doc), ...positionsToAnalyse(trees.b, doc)];
    const found: RepertoireDoc["evals"] = {};
    setProgress({ done: 0, total: todo.length });
    try {
      const eng = engine();
      for (let i = 0; i < todo.length; i++) {
        const fen = todo[i]!;
        const term = terminalScore(fen);
        if (term) found[fenKey(fen)] = { cp: scoreToCp(term), best: null, bestSan: null, depth: 0 };
        else {
          const l = await eng.analyse(fen, ANALYSIS_DEPTH);
          if (l) found[fenKey(fen)] = { cp: scoreToCp(l.score), best: l.pv[0] ?? null, bestSan: l.pv[0] ? pvToSan(fen, [l.pv[0]])[0] ?? null : null, depth: l.depth };
        }
        setProgress({ done: i + 1, total: todo.length });
        if (i % 20 === 19 || i === todo.length - 1) {
          const batch = { ...found };
          update((d) => ({ ...d, evals: { ...d.evals, ...batch } }));
        }
      }
      update((d) => syncCards(trees.b, syncCards(trees.w, d)));
    } finally {
      running.current = false;
      setProgress(null);
    }
  }, [resp, trees, doc, engine, update]);
  // une fois les parties chargées : on analyse ce qui ne l'est pas encore, puis on crée les exercices
  const started = useRef(false);
  useEffect(() => {
    if (!resp || started.current) return;
    started.current = true;
    if (pending.length > 0) void analyse();
    else update((d) => syncCards(trees.b, syncCards(trees.w, d)));
  }, [resp, pending.length, analyse, trees, update]);

  const cards = useMemo(() => Object.values(doc.cards), [doc.cards]);
  const due = useMemo(() => cards.filter((c) => isDue(c)).sort((a, b) => b.times - a.times), [cards]);

  const download = () => {
    const pgn = exportPgn(tree, doc, me ?? "Joueur");
    // BOM UTF-8 : les accents s'affichent correctement dans ChessBase sous Windows
    const url = URL.createObjectURL(new Blob(["\uFEFF" + pgn], { type: "application/x-chess-pgn;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `repertoire-${color === "w" ? "blancs" : "noirs"}-${me}.pgn` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const startTraining = (key?: string) => { setTrainKey(key ?? due[0]?.key ?? null); setMode("train"); window.scrollTo({ top: 0, behavior: "instant" }); };

  return (
    <main className="arena-app">
      <header className="mx-auto flex h-13 max-w-[1400px] items-center gap-3 px-3 lg:px-6">
        <a href="/play" className="font-display text-lg font-bold tracking-tight">Chess<span className="text-neon">Arena</span></a>
        <span className="text-sm text-muted">· Répertoire</span>
        <div className="ml-auto flex items-center gap-1.5">
          <a href="/history" className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">Mes parties</a>
          <a href="/play" className="neon-btn rounded-lg px-3 py-1.5 text-sm font-semibold">Jouer</a>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-2 pb-8 sm:px-3 lg:px-6">
        {loadError && <p role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-sm text-danger">{loadError}</p>}
        {!resp && !loadError && <p className="px-1 text-sm text-muted">Chargement de tes parties…</p>}
        {resp && (
          <>
            {/* ─── Bandeau : couleur, analyse, entraînement, export ─── */}
            <div className="panel mb-3 flex flex-wrap items-center gap-2 p-3">
              <div className="flex rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Couleur">
                {(["w", "b"] as const).map((c) => (
                  <button key={c} type="button" role="tab" aria-selected={color === c} onClick={() => { setColor(c); setMode("tree"); }}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold ${color === c ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                    <span className={`inline-block size-2.5 rounded-sm border border-line ${c === "w" ? "bg-[#E7ECF3]" : "bg-[#1C2233]"}`} />
                    Avec les {COLOR_NAME[c]} <span className="tabular text-xs font-normal text-muted">{trees[c].games}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted">
                {progress ? `${ENGINE_NAME} analyse ton répertoire… ${progress.done}/${progress.total}`
                  : pending.length ? `${pending.length} position${pending.length > 1 ? "s" : ""} à analyser`
                  : `Répertoire analysé par ${ENGINE_NAME}`}
                {saveState === "saving" ? " · enregistrement…" : saveState === "saved" ? " · enregistré" : saveState === "error" ? " · échec de l'enregistrement" : ""}
              </p>
              <div className="ml-auto flex flex-wrap gap-2">
                {!progress && pending.length > 0 && (
                  <button type="button" onClick={() => void analyse()} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Analyser</button>
                )}
                <button type="button" disabled={mode === "tree" && (due.length === 0 || !!progress)} onClick={() => (mode === "train" ? setMode("tree") : startTraining())}
                  className="neon-btn rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40">
                  {mode === "train" ? "Retour au répertoire" : `S'entraîner${due.length ? ` · ${due.length} à faire` : ""}`}
                </button>
                <button type="button" disabled={tree.games === 0} onClick={download}
                  className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-40" title="Fichier PGN avec variantes : ChessBase, Lichess, Chessable…">
                  ⬇ PGN pour ChessBase
                </button>
              </div>
              {progress && (
                <div className="h-1 w-full overflow-hidden rounded bg-surface-2">
                  <div className="h-full bg-neon transition-all" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
                </div>
              )}
            </div>

            {mode === "train"
              ? <Training key={trainKey ?? "none"} cardKey={trainKey} doc={doc} due={due} paths={paths} engine={engine} update={update}
                  onNext={(k) => setTrainKey(k)} onDone={() => setMode("tree")} />
              : tree.games === 0
                ? <div className="panel p-4 text-sm text-muted">Pas encore de partie avec les {COLOR_NAME[color]}. <a href="/play" className="text-neon underline">Joue une partie</a> : ton répertoire se construit tout seul.</div>
                : <TreeView key={color} tree={tree} doc={doc} cards={cards.filter((c) => c.color === color)} paths={paths[color]} onTrain={startTraining} busy={!!progress} />}
          </>
        )}
      </div>
    </main>
  );
}

// ═══ Navigation dans l'arbre ═════════════════════════════════════════════════
function TreeView({ tree, doc, cards, paths, onTrain, busy }: {
  tree: Tree; doc: RepertoireDoc; cards: Card[]; paths: Map<string, string[]>; onTrain: (key: string) => void; busy: boolean;
}) {
  const [settings] = useSettings();
  const [line, setLine] = useState<Array<{ uci: string; san: string; fen: string }>>([]);
  const fen = line.at(-1)?.fen ?? START;
  const key = fenKey(fen);
  const node = tree.nodes.get(key);
  const mine = turnOf(fen) === tree.color;
  const rep = mine ? repertoireMove(node, key, doc) : null;
  const card = doc.cards[key];
  const go = (uci: string) => { const r = playUci(fen, uci); if (r) setLine((l) => [...l, { uci, san: r.san, fen: r.fen }]); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { setLine((l) => l.slice(0, -1)); e.preventDefault(); }
      else if (e.key === "ArrowUp" || e.key === "Home") { setLine([]); e.preventDefault(); }
      else if (e.key === "ArrowRight" && (rep ?? node?.moves[0])) { go((rep ?? node!.moves[0]!).uci); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // tant qu'elle n'est pas corrigée, l'erreur la plus jouée n'est pas présentée comme « coup de répertoire »
  const repIsError = !!rep && !rep.learned && !!card && card.played === rep.uci;
  const arrows: Array<{ from: string; to: string; color?: string }> = [];
  if (rep && !repIsError) arrows.push({ from: rep.uci.slice(0, 2), to: rep.uci.slice(2, 4), color: "#22c55e" });
  if (card && (repIsError || card.played !== rep?.uci)) arrows.push({ from: card.played.slice(0, 2), to: card.played.slice(2, 4), color: "#ef4444" });
  const errors = [...cards].sort((a, b) => Number(isDue(b)) - Number(isDue(a)) || b.times - a.times);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section className="mx-auto flex w-full flex-col gap-2" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 230px)))" }}>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => setLine([])} className={`rounded px-1.5 py-0.5 ${line.length === 0 ? "bg-neon/15 text-neon" : "text-muted hover:text-text"}`}>Début</button>
          {line.map((s, i) => (
            <button key={i} type="button" onClick={() => setLine((l) => l.slice(0, i + 1))}
              className={`rounded px-1 py-0.5 font-medium ${i === line.length - 1 ? "bg-neon/15 text-neon" : "hover:bg-surface-2"}`}>
              {i % 2 === 0 ? `${i / 2 + 1}.` : ""}{s.san}
            </button>
          ))}
        </div>
        <GameBoard fen={fen} serverFen={fen} orientation={tree.color} myColor={tree.color} interactive={false} myTurn={false}
          lastMove={line.at(-1)?.uci ?? null} premoves={[]} theme={settings.boardTheme} coordinates={settings.coordinates}
          onMove={() => false} onCancelPremoves={() => {}} arrows={arrows} />
        <div className="flex gap-1.5">
          <button type="button" className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-lg text-muted hover:text-text disabled:opacity-30" onClick={() => setLine([])} disabled={!line.length} aria-label="Début">⏮</button>
          <button type="button" className="flex-1 rounded-lg bg-surface-2 px-3 py-2 text-lg text-muted hover:text-text disabled:opacity-30" onClick={() => setLine((l) => l.slice(0, -1))} disabled={!line.length} aria-label="Coup précédent">◀</button>
        </div>
      </section>

      <aside className="flex flex-col gap-3">
        {card && (
          <div className={`panel p-3 ${isDue(card) ? "border-danger/50" : "border-win/40"}`}>
            <p className="text-sm font-semibold">
              {isDue(card) ? <span className="text-danger">Erreur récurrente</span> : <span className="text-win">Erreur corrigée ✓</span>}
            </p>
            <p className="mt-1 text-sm">
              Tu as joué <b>{card.playedSan}<span className={MARK_CLS[card.mark ?? ""]}>{card.mark}</span></b> dans {card.times} partie{card.times > 1 ? "s" : ""}.
              {!isDue(card) && doc.choices[key] && <> Ton coup de répertoire est maintenant <b className="text-win">{doc.choices[key]!.san}</b>.</>}
            </p>
            <button type="button" disabled={busy} onClick={() => onTrain(key)} className="neon-btn mt-2 w-full rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40">
              {isDue(card) ? "Trouver le meilleur coup" : "Réviser cette position"}
            </button>
          </div>
        )}

        <div className="panel p-3">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted">
            {mine ? "Ton coup ici" : "Les réponses de tes adversaires"} {node ? `· ${node.total} partie${node.total > 1 ? "s" : ""}` : ""}
          </p>
          {!node && !rep && <p className="text-sm text-muted">Fin de ton répertoire dans cette ligne.</p>}
          <ul className="flex flex-col gap-1">
            {rep?.learned && !node?.moves.some((m) => m.uci === rep.uci) && (
              <li><button type="button" onClick={() => go(rep.uci)} className="flex w-full items-center gap-2 rounded-lg border border-win/40 bg-win/10 px-2.5 py-2 text-left text-sm">
                <span className="font-semibold text-win">{rep.san}</span><span className="text-xs text-win">★ appris à l'entraînement</span>
              </button></li>
            )}
            {node?.moves.map((m) => {
              const j = mine ? judge(fen, m.uci, doc, tree.color) : null;
              const isRep = rep?.uci === m.uci && !repIsError;
              const isErr = repIsError && rep?.uci === m.uci;
              const pct = Math.round((100 * m.points) / m.count);
              return (
                <li key={m.uci}>
                  <button type="button" onClick={() => go(m.uci)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2 ${isRep ? "border border-win/40 bg-win/5" : isErr ? "border border-danger/40 bg-danger/5" : "border border-transparent"}`}>
                    <span className="w-16 font-semibold">{m.san}{j?.mark && <span className={`ml-0.5 ${MARK_CLS[j.mark]}`}>{j.mark}</span>}</span>
                    <span className="flex-1 text-xs text-muted">{m.count}× · score {pct} %</span>
                    <span className="h-1.5 w-16 overflow-hidden rounded bg-danger/40"><span className="block h-full bg-win" style={{ width: `${pct}%` }} /></span>
                    {isRep && <span className="text-xs text-win">{rep!.learned ? "★" : "répertoire"}</span>}
                    {isErr && <span className="text-xs text-danger">ton erreur</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {mine && doc.evals[key]?.bestSan && (
            <p className="mt-2 text-xs text-muted">{ENGINE_NAME} : {doc.evals[key]!.bestSan} · {(() => { const w = winPct(doc.evals[key]!.cp); return `${Math.round(tree.color === "w" ? w : 100 - w)} % de chances pour toi`; })()}</p>
          )}
        </div>

        <div className="panel p-3">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted">Erreurs repérées avec les {COLOR_NAME[tree.color]} · {errors.length}</p>
          {errors.length === 0 && <p className="text-sm text-muted">{busy ? "Analyse en cours…" : "Aucune erreur répétée dans tes ouvertures. Bravo !"}</p>}
          <ul className="flex flex-col gap-1">
            {errors.map((c) => {
              const p = paths.get(c.key) ?? [];
              const days = Math.ceil((new Date(c.due).getTime() - Date.now()) / 86_400_000);
              return (
                <li key={c.key}>
                  <button type="button" onClick={() => onTrain(c.key)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-muted">{lineLabel(p)}</span>
                      <span className="font-medium">{p.length % 2 === 0 ? `${p.length / 2 + 1}.` : `${Math.ceil(p.length / 2)}…`}{c.playedSan}<span className={MARK_CLS[c.mark ?? ""]}>{c.mark}</span></span>
                      <span className="text-xs text-muted"> · {c.times}×</span>
                    </span>
                    {isDue(c)
                      ? <span className="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-xs text-danger">à faire</span>
                      : <span className="shrink-0 rounded bg-win/15 px-1.5 py-0.5 text-xs text-win">✓ révision dans {days} j</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

// ═══ Exercice : trouver le meilleur coup ═════════════════════════════════════
function Training({ cardKey, doc, due, paths, engine, update, onNext, onDone }: {
  cardKey: string | null; doc: RepertoireDoc; due: Card[]; paths: Record<Color, Map<string, string[]>>;
  engine: () => Engine; update: (f: (d: RepertoireDoc) => RepertoireDoc) => void; onNext: (k: string) => void; onDone: () => void;
}) {
  const [settings] = useSettings();
  const card = cardKey ? doc.cards[cardKey] : undefined;
  const [fen, setFen] = useState(card?.fen ?? START);
  const [last, setLast] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [state, setState] = useState<"ask" | "checking" | "ok" | "wrong" | "revealed">("ask");
  const [msg, setMsg] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  if (!card) {
    return (
      <div className="panel mx-auto max-w-lg p-5 text-center">
        <p className="font-display text-2xl font-bold text-win">Tout est à jour ✓</p>
        <p className="mt-1 text-sm text-muted">Aucun exercice à faire pour l'instant. Les positions reviennent au bon moment pour que tu les retiennes.</p>
        <button type="button" onClick={onDone} className="neon-btn mt-4 rounded-lg px-4 py-2 font-semibold">Voir mon répertoire</button>
      </div>
    );
  }
  const p = paths[card.color].get(card.key) ?? [];
  const moveNo = p.length % 2 === 0 ? `${p.length / 2 + 1}.` : `${Math.ceil(p.length / 2)}…`;
  const nextDue = due.filter((c) => c.key !== card.key);

  const onMove = (from: string, to: string, promotion?: string): boolean => {
    if (state !== "ask" && state !== "wrong") return false;
    const uci = from + to + (promotion ?? "");
    const r = playUci(card.fen, uci);
    if (!r) return false;
    setFen(r.fen); setLast(uci); setState("checking"); setMsg(null);
    void (async () => {
      let ok = uci === card.best;
      let lossTxt = "";
      if (!ok) {
        const before = doc.evals[card.key]?.cp ?? 0;
        const term = terminalScore(r.fen);
        const l = term ? null : await engine().analyse(r.fen, ANALYSIS_DEPTH);
        const after = term ? scoreToCp(term) : l ? scoreToCp(l.score) : null;
        if (after !== null) {
          const loss = card.color === "w" ? winPct(before) - winPct(after) : winPct(after) - winPct(before);
          ok = loss <= ACCEPT_LOSS;
          lossTxt = ` (−${Math.max(0, Math.round(loss))} % de chances de gain)`;
        }
      }
      if (ok) {
        setState("ok"); setAnswer(r.san);
        setMsg(uci === card.best ? `${r.san} : c'est le meilleur coup !` : `${r.san} : excellent aussi (${ENGINE_NAME} préférait ${card.bestSan}).`);
        update((d) => review(d, card.key, tries === 0, { uci, san: r.san }));
      } else {
        const n = tries + 1;
        setTries(n);
        if (n >= 3) {
          const b = playUci(card.fen, card.best);
          setFen(b?.fen ?? card.fen); setLast(card.best); setState("revealed"); setAnswer(card.bestSan);
          setMsg(`La solution était ${card.bestSan}. Elle est enregistrée dans ton répertoire, et la position reviendra demain.`);
          update((d) => review(d, card.key, false, null));
        } else {
          setState("wrong");
          setMsg(`${r.san} n'est pas le bon coup${lossTxt}. Réessaie !`);
          setTimeout(() => { setFen(card.fen); setLast(null); }, 700);
        }
      }
    })();
    return true;
  };

  const pieceAt = card.best.slice(0, 2);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section className="mx-auto flex w-full flex-col gap-2" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 230px)))" }}>
        <p className="text-sm text-muted">{lineLabel(p)} <span className="font-semibold text-text">{moveNo} ?</span></p>
        <GameBoard fen={fen} serverFen={fen} orientation={card.color} myColor={card.color}
          interactive={state === "ask" || state === "wrong"} myTurn lastMove={last} premoves={[]}
          theme={settings.boardTheme} coordinates={settings.coordinates}
          onMove={(f, t, pr) => onMove(f, t, pr)} onCancelPremoves={() => {}} />
      </section>

      <aside className="flex flex-col gap-3">
        <div className="panel p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted">Exercice · {COLOR_NAME[card.color]} · {nextDue.length + 1} à faire</p>
          <p className="mt-1 font-display text-xl font-bold">Trouve le meilleur coup</p>
          <p className="mt-1 text-sm text-muted">
            Dans cette position, tu as joué <b className="text-text">{card.playedSan}<span className={MARK_CLS[card.mark ?? ""]}>{card.mark}</span></b> dans {card.times} partie{card.times > 1 ? "s" : ""}.
            {card.solved > 0 && ` Déjà trouvé ${card.solved} fois.`}
          </p>
          {msg && (
            <p role="status" className={`mt-3 rounded-lg p-2.5 text-sm ${state === "ok" ? "bg-win/15 text-win" : state === "revealed" ? "bg-gold/10 text-gold" : "bg-danger/10 text-danger"}`}>
              {msg}
            </p>
          )}
          {state === "checking" && <p className="mt-3 text-sm text-muted">{ENGINE_NAME} vérifie ton coup…</p>}
          {state === "ok" && answer && <p className="mt-2 text-sm">✓ <b>{answer}</b> est enregistré dans ton répertoire.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {(state === "ask" || state === "wrong") && !hint && (
              <button type="button" onClick={() => setHint(true)} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Indice</button>
            )}
            {hint && (state === "ask" || state === "wrong") && <p className="self-center text-sm text-gold">Indice : joue la pièce en {pieceAt}.</p>}
            {(state === "ok" || state === "revealed") && (
              nextDue.length > 0
                ? <button type="button" onClick={() => onNext(nextDue[0]!.key)} className="neon-btn rounded-lg px-4 py-2 font-semibold">Exercice suivant →</button>
                : <button type="button" onClick={onDone} className="neon-btn rounded-lg px-4 py-2 font-semibold">Terminé · voir mon répertoire</button>
            )}
          </div>
        </div>
        <p className="px-1 text-[11px] text-muted">
          Un coup est accepté s'il est aussi bon que celui du moteur à {ACCEPT_LOSS} % de chances de gain près. Une position réussie revient
          après 1, 3, 7, 21 puis 60 jours ; ratée, elle revient le lendemain.
        </p>
      </aside>
    </div>
  );
}
