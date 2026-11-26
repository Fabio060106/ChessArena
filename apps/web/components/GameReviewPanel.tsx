"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Engine, ENGINE_NAME, terminalScore, type EngineLine } from "../lib/engine";
import { loadOpeningBook } from "../lib/openingBook";
import { buildTeaching, quizPrompt, TEACHING_VERSION, type TeachMove, type TeachingReview } from "../lib/pedagogy";
import { replayFromSans } from "../lib/replay";
import { useSettings } from "../lib/settings";
import type { AuthProvider } from "../lib/socket";
import { sharedReview } from "../hooks/useRelay";
import { GameBoard } from "./GameBoard";

/** Profondeur et nombre de suites de l'analyse d'après-partie : assez pour expliquer, rapide même sur téléphone. */
const DEPTH = 12;
const LINES = 3;

const MARK_CLS: Record<string, string> = { "??": "text-danger", "?": "text-[#fb923c]", "?!": "text-gold", "!": "text-win" };

function analyseMulti(engine: Engine, fen: string): Promise<EngineLine[]> {
  return new Promise((resolve) => {
    let last: EngineLine[] = [];
    void engine.analyseLines(fen, DEPTH, LINES, (ls) => { last = ls; }).then((best) => resolve(last.length ? last : best ? [best] : []));
  });
}

/**
 * Analyse pédagogique d'une partie terminée : calculée une seule fois par Stockfish (dans le navigateur du premier
 * spectateur), puis partagée avec tous via le serveur. Trois vues : résumé, coup par coup, quiz.
 */
export function GameReviewPanel({ relayId, round, index, sans, ucis, names, result, onGo, getAuth, ply = -1 }: {
  relayId: string; round: number; index: number;
  sans: readonly string[]; ucis: readonly string[];
  names: { w: string; b: string };
  result: string | null;
  onGo: (ply: number) => void;
  getAuth: AuthProvider;
  /** demi-coup affiché sur l'échiquier (surligné dans la partie commentée) */
  ply?: number;
}) {
  const steps = useMemo(() => replayFromSans(sans), [sans]);
  const [review, setReview] = useState<TeachingReview | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"lesson" | "opening" | "summary" | "moves" | "quiz">("lesson");
  const localKey = `arena.teach${TEACHING_VERSION}.${relayId}.${round}.${index}.${sans.length}`;

  useEffect(() => {
    setReview(null); setFailed(false); setProgress(null);
    let live = true;
    let engine: Engine | null = null;
    const shared = sharedReview(getAuth);
    const ok = (r: unknown): r is TeachingReview => !!r && typeof r === "object" && (r as TeachingReview).version === TEACHING_VERSION && Array.isArray((r as TeachingReview).moves) && (r as TeachingReview).moves.length === sans.length;
    (async () => {
      // 1. déjà sur cet appareil ; 2. déjà calculée par un autre spectateur ; 3. on la calcule (et on la partage)
      try { const c = JSON.parse(localStorage.getItem(localKey) ?? "null") as unknown; if (ok(c)) { setReview(c); return; } } catch { /* ignoré */ }
      const s = await shared.get({ relayId, round, index, plies: sans.length });
      if (!live) return;
      if (ok(s)) { setReview(s); try { localStorage.setItem(localKey, JSON.stringify(s)); } catch { /* plein */ } return; }
      try { engine = new Engine(); } catch { setFailed(true); return; }
      const fens = steps.map((x) => x.fen);
      const lines: EngineLine[][] = [];
      setProgress({ done: 0, total: fens.length });
      for (let i = 0; i < fens.length; i++) {
        const t = terminalScore(fens[i]!);
        const ls = t ? [{ depth: 0, score: t, pv: [] }] : await analyseMulti(engine, fens[i]!);
        if (!live) return;
        if (!ls.length) { setFailed(true); return; }
        lines.push(ls);
        setProgress({ done: i + 1, total: fens.length });
      }
      const book = await loadOpeningBook();
      if (!live) return;
      const r = buildTeaching({ sans, ucis, fens, lines, names, result, book });
      setReview(r); setProgress(null);
      try { localStorage.setItem(localKey, JSON.stringify(r)); } catch { /* plein */ }
      shared.save({ relayId, round, index, sans: [...sans], review: r });
    })().catch(() => setFailed(true));
    return () => { live = false; (engine as Engine | null)?.terminate(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localKey]);

  if (failed) return <p className="panel p-3 text-sm text-muted">L'analyse n'a pas pu se lancer sur cet appareil. Utilise « Analyser cette position ».</p>;
  if (!review) {
    const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <section className="panel p-3" aria-label="Analyse Stockfish de la partie">
        <p className="text-sm font-semibold">{ENGINE_NAME} prépare l'analyse commentée de la partie…</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-2"><div className="h-full bg-neon transition-all" style={{ width: `${pct}%` }} /></div>
        <p className="tabular mt-1 text-xs text-muted">{progress ? `${progress.done} / ${progress.total} positions · elle sera ensuite disponible pour tous les spectateurs` : "Recherche d'une analyse déjà faite…"}</p>
      </section>
    );
  }
  return (
    <section className="panel flex flex-col gap-3 p-3" aria-label="Analyse Stockfish de la partie">
      <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Vues de l'analyse">
        {([["lesson", "Partie"], ...(review.book ? [["opening", "Ouverture"] as const] : []), ["summary", "Résumé"], ["moves", "Coups"], ["quiz", "Quiz"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`flex-1 rounded-md px-1 py-1.5 text-xs font-semibold sm:px-2 sm:text-sm ${tab === k ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>{label}</button>
        ))}
      </div>
      {tab === "lesson" && <Lesson review={review} onGo={onGo} ply={ply} result={result} />}
      {tab === "opening" && review.book && <OpeningTab book={review.book} ucis={ucis} onGo={onGo} ply={ply} />}
      {tab === "summary" && <Summary review={review} names={names} ucis={ucis} onGo={onGo} />}
      {tab === "moves" && <MoveByMove review={review} onGo={onGo} />}
      {tab === "quiz" && <Quiz review={review} names={names} fens={steps.map((x) => x.fen)} onGo={onGo} />}
      <p className="text-[11px] text-muted/80">{ENGINE_NAME}, profondeur {DEPTH}, {LINES} suites par position. Explications générées automatiquement à partir de l'analyse.</p>
    </section>
  );
}

/**
 * La partie commentée, comme dans un livre : les coups se suivent, et le commentaire s'insère juste après
 * les coups qui le méritent (erreurs, coups « ! », fin de la théorie, roque, coups doubles, entrée en finale…),
 * avec la variante entre parenthèses. Toucher un coup l'affiche sur l'échiquier.
 */
function Lesson({ review, onGo, ply, result }: { review: TeachingReview; onGo: (p: number) => void; ply: number; result: string | null }) {
  // paragraphes : une suite de coups, terminée par un coup commenté
  const blocks: Array<{ moves: TeachMove[]; note: TeachMove | null }> = [];
  let cur: TeachMove[] = [];
  for (const m of review.moves) {
    cur.push(m);
    if (m.note) { blocks.push({ moves: cur, note: m }); cur = []; }
  }
  if (cur.length) blocks.push({ moves: cur, note: null });
  const moveBtn = (m: TeachMove, i: number) => {
    const showNum = m.mover === "w" || i === 0;
    return (
      <Fragment key={m.ply}><span className="whitespace-nowrap">
        {showNum && <span className="text-muted">{Math.ceil(m.ply / 2)}{m.mover === "w" ? "." : "…"}&nbsp;</span>}
        <button type="button" onClick={() => onGo(m.ply)} aria-current={m.ply === ply ? "true" : undefined}
          className={`rounded px-0.5 font-semibold ${m.ply === ply ? "bg-neon/20 text-neon" : "hover:bg-surface-2"} ${m.mark === "??" || m.mark === "?" ? "text-danger" : m.mark === "?!" ? "text-gold" : m.mark === "!" ? "text-neon" : ""}`}>
          {m.san}{m.mark}
        </button>
      </span>{" "}</Fragment>
    );
  };
  return (
    <div className="flex flex-col gap-2.5 font-serif text-[14.5px] leading-relaxed lg:max-h-[70vh] lg:overflow-y-auto lg:pr-1" aria-label="Partie commentée">
      {review.lesson.intro && <p className="font-sans text-[13.5px] italic text-muted">{review.lesson.intro}</p>}
      {blocks.map((b, k) => (
        <div key={k}>
          <p className="font-sans">{b.moves.map(moveBtn)}</p>
          {b.note && (
            <p className="mt-1 border-l-2 border-gold/50 pl-2.5">
              {b.note.note}
              {b.note.variation && <span className="font-sans text-[13px] text-muted"> ({b.note.variation})</span>}
            </p>
          )}
        </div>
      ))}
      {result && <p className="font-sans font-bold">{result}</p>}
      {review.lesson.takeaways.length > 0 && (
        <section className="rounded-lg bg-surface-2 p-3 font-sans">
          <h3 className="mb-1.5 font-display text-sm font-bold text-neon">Ce qu'il faut retenir</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-snug">
            {review.lesson.takeaways.slice(0, 3).map((t) => <li key={t}>{t}</li>)}
          </ul>
        </section>
      )}
      <p className="font-sans text-xs text-muted">Commentaires générés automatiquement à partir de l'analyse de {ENGINE_NAME}.</p>
    </div>
  );
}

/** L'ouverture coup par coup : la variante atteinte, et à chaque coup les autres sous-lignes du livre (cliquables). */
function OpeningTab({ book, ucis, onGo, ply }: { book: NonNullable<TeachingReview["book"]>; ucis: readonly string[]; onGo: (p: number) => void; ply: number }) {
  return (
    <div className="flex flex-col gap-2 lg:max-h-[70vh] lg:overflow-y-auto lg:pr-1" aria-label="Ouverture et sous-lignes">
      <div className="rounded-lg bg-surface-2 p-2.5">
        <p className="text-xs text-muted">Variante atteinte · {book.eco}</p>
        <p className="font-semibold">{book.name}</p>
        {book.leftAt && <p className="mt-0.5 text-xs text-muted">Plus de sous-variante nommée après le coup {Math.ceil((book.leftAt - 1) / 2)}.</p>}
      </div>
      <ol className="flex flex-col gap-1.5">
        {book.plies.map((x) => (
          <li key={x.ply} className="border-b border-line/50 pb-1.5 text-[13px]">
            <div className="flex items-baseline gap-2">
              <button type="button" onClick={() => onGo(x.ply)} className={`shrink-0 rounded px-1 font-semibold ${x.ply === ply ? "bg-neon/20 text-neon" : "hover:bg-surface-2"}`}>
                {Math.ceil(x.ply / 2)}{x.ply % 2 ? "." : "…"} {x.san}
              </button>
              <span className="min-w-0 truncate text-muted">{x.name ?? ""}</span>
            </div>
            {x.alternatives.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1 pl-1">
                <span className="text-[11px] text-muted">ou :</span>
                {x.alternatives.map((a) => (
                  <a key={a.uci} href={`/analyse?m=${[...ucis.slice(0, x.ply - 1), a.uci].join(",")}`} title={a.name}
                    className="max-w-full truncate rounded border border-line px-1.5 py-0.5 text-[11px] hover:border-neon hover:text-neon">
                    <b>{a.san}</b> <span className="text-muted">{a.name.replace(/^[^:]*: /, "")}</span>
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-muted">Noms des variantes : base libre lichess-org/chess-openings. Touche une sous-ligne pour l'ouvrir sur l'échiquier d'analyse.</p>
    </div>
  );
}

function Summary({ review, names, ucis, onGo }: { review: TeachingReview; names: { w: string; b: string }; ucis: readonly string[]; onGo: (p: number) => void }) {
  const n = review.curve.length - 1;
  return (
    <>
      <div>
        {review.opening && <p className="text-xs text-muted">Ouverture : <span className="font-semibold text-text">{review.opening}</span></p>}
        <p className="mt-1 text-sm leading-relaxed">{review.summary}</p>
      </div>
      <table className="w-full table-fixed text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-muted">
          <tr><th className="w-2/5 text-left font-normal">Joueur</th><th className="text-right font-normal">Précision</th><th className="text-right font-normal">?!</th><th className="text-right font-normal">?</th><th className="text-right font-normal">??</th></tr>
        </thead>
        <tbody>
          {(["w", "b"] as const).map((c) => (
            <tr key={c}>
              <td className="truncate py-1 pr-2 font-medium">{names[c]}</td>
              <td className="tabular text-right font-semibold text-neon">{review.accuracy[c] !== null ? `${review.accuracy[c]} %` : "—"}</td>
              <td className="tabular text-right text-gold">{review.counts[c]["?!"]}</td>
              <td className="tabular text-right text-[#fb923c]">{review.counts[c]["?"]}</td>
              <td className="tabular text-right text-danger">{review.counts[c]["??"]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {n > 0 && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-16 w-full cursor-pointer rounded bg-[#1C2233]" role="img" aria-label="Courbe d'évaluation (cliquer pour aller au coup)"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onGo(Math.max(0, Math.min(n, Math.round(((e.clientX - r.left) / r.width) * n)))); }}>
          <polygon points={`0,100 ${review.curve.map((w, i) => `${(i / n) * 100},${100 - w}`).join(" ")} 100,100`} fill="#E7ECF3" opacity={0.85} />
          <line x1="0" y1="50" x2="100" y2="50" stroke="#22d3ee" strokeOpacity={0.4} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
          {review.moments.map((m) => (
            <line key={m.ply} x1={(m.ply / n) * 100} y1="0" x2={(m.ply / n) * 100} y2="100" stroke={m.mark === "??" ? "#ef4444" : m.mark === "?" ? "#fb923c" : "#eab308"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      )}
      {review.moments.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Moments clés</p>
          <ol className="flex flex-col gap-2">
            {review.moments.map((km) => {
              const m = review.moves[km.ply - 1]!;
              return (
                <li key={km.ply} className="rounded-lg bg-surface-2 p-2 text-sm">
                  <button type="button" onClick={() => onGo(km.ply)} className="font-semibold hover:underline">{km.move}<span className={`ml-0.5 ${MARK_CLS[km.mark] ?? ""}`}>{km.mark}</span></button>
                  <span className="ml-1 text-muted">{m.comment}</span>
                  {m.alternatives[0] && <span className="mt-0.5 block text-xs text-muted">Suite proposée : {m.alternatives[0].line}</span>}
                  <span className="mt-1 flex gap-3 text-xs">
                    <button type="button" onClick={() => onGo(km.ply - 1)} className="text-neon hover:underline">Voir la position</button>
                    <a href={`/analyse?m=${ucis.slice(0, km.ply - 1).join(",")}`} className="text-neon hover:underline">Essayer d'autres coups</a>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : <p className="text-sm text-muted">Aucune erreur notable : les deux joueurs ont trouvé de bons coups toute la partie.</p>}
    </>
  );
}

/** Chaque coup, commenté : verdict, explication, autres options. Clic = l'échiquier va au coup. */
function MoveByMove({ review, onGo }: { review: TeachingReview; onGo: (p: number) => void }) {
  const [onlyKey, setOnlyKey] = useState(false);
  const list = onlyKey ? review.moves.filter((m) => m.mark !== "") : review.moves;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={onlyKey} onChange={(e) => setOnlyKey(e.target.checked)} /> Seulement les coups marquants (!, ?!, ?, ??)
      </label>
      <ol className="flex flex-col gap-1.5 lg:max-h-[60vh] lg:overflow-y-auto lg:pr-1">
        {list.map((m) => <MoveRow key={m.ply} m={m} onGo={onGo} />)}
      </ol>
    </div>
  );
}

function MoveRow({ m, onGo }: { m: TeachMove; onGo: (p: number) => void }) {
  const num = `${Math.ceil(m.ply / 2)}${m.mover === "w" ? "." : "…"}`;
  return (
    <li className={`rounded-lg p-2 text-sm ${m.mark && m.mark !== "!" ? "bg-surface-2" : m.mark === "!" ? "bg-win/10" : ""}`}>
      <button type="button" onClick={() => onGo(m.ply)} className="font-semibold hover:underline">
        <span className="text-muted">{num} </span>{m.san}{m.mark && <span className={`ml-0.5 ${MARK_CLS[m.mark]}`}>{m.mark}</span>}
      </button>
      <span className="tabular ml-2 text-xs text-muted">{m.evalAfter}</span>
      <span className="block text-[13px] leading-snug text-muted">{m.comment}</span>
      {!m.theory && m.alternatives.length > 0 && (
        <span className="mt-0.5 block text-xs text-muted/90">
          Autres options : {m.alternatives.map((a, i) => <span key={i}>{i > 0 && " · "}<b className="text-text">{a.san}</b> ({a.eval}){a.idea ? `, ${a.idea}` : ""}{i === 0 && a.line ? ` — ${a.line}` : ""}</span>)}
        </span>
      )}
    </li>
  );
}

/** « Trouve le meilleur coup » : la position avant chaque moment clé ; on joue sur l'échiquier, puis on voit la réponse. */
function Quiz({ review, names, fens, onGo }: { review: TeachingReview; names: { w: string; b: string }; fens: readonly string[]; onGo: (p: number) => void }) {
  const [settings] = useSettings();
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState<{ uci: string; good: boolean } | null>(null);
  const [score, setScore] = useState(0);
  const done = useRef(new Set<number>());
  if (!review.quiz.length) return <p className="text-sm text-muted">Pas de position de quiz dans cette partie : aucune erreur marquante ni coup unique.</p>;
  if (i >= review.quiz.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        <p className="font-display text-2xl font-bold">{score} / {review.quiz.length}</p>
        <p className="text-sm text-muted">{score === review.quiz.length ? "Parfait, tu as vu tout ce que Stockfish a vu !" : score > 0 ? "Bien joué ! Revois les autres positions dans « Coup par coup »." : "Pas facile ! Les explications sont dans « Coup par coup »."}</p>
        <button type="button" onClick={() => { setI(0); setScore(0); setAnswer(null); done.current.clear(); }} className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm">Recommencer</button>
      </div>
    );
  }
  const ply = review.quiz[i]!;
  const m = review.moves[ply - 1]!;
  const fen = fens[ply - 1]!;
  const tryMove = (from: string, to: string, promotion?: string) => {
    if (answer) return false;
    const uci = from + to + (promotion ?? "");
    const good = m.goodUcis.some((u) => u.slice(0, 4) === uci.slice(0, 4));
    setAnswer({ uci, good });
    if (good && !done.current.has(ply)) { done.current.add(ply); setScore((s) => s + 1); }
    return false; // l'échiquier du quiz ne garde pas le coup : la réponse s'affiche en dessous
  };
  const target = m.mark === "!" ? m.san : (m.best ?? m.alternatives[0]?.san ?? "");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">Position {i + 1} / {review.quiz.length} · score {score}</p>
      <p className="text-sm font-semibold">{quizPrompt(m, names)}</p>
      <div className="mx-auto w-full max-w-[340px]">
        <GameBoard fen={fen} serverFen={fen} orientation={m.mover} myColor={m.mover} interactive={!answer} myTurn
          lastMove={null} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette}
          autoQueen coordinates={settings.coordinates} onMove={tryMove} onCancelPremoves={() => {}}
          arrows={answer ? [{ from: (m.goodUcis[0] ?? "").slice(0, 2), to: (m.goodUcis[0] ?? "").slice(2, 4), color: "#22c55e" }] : []} />
      </div>
      {!answer ? (
        <div className="flex justify-between text-xs">
          <span className="text-muted">Joue ton coup sur l'échiquier.</span>
          <button type="button" onClick={() => setAnswer({ uci: "", good: false })} className="text-neon hover:underline">Voir la réponse</button>
        </div>
      ) : (
        <div className="rounded-lg bg-surface-2 p-2 text-sm">
          <p className={`font-semibold ${answer.good ? "text-win" : answer.uci ? "text-danger" : ""}`}>
            {answer.good ? "Bravo, c'est le bon coup !" : answer.uci ? `Non : la bonne réponse était ${target}.` : `La réponse : ${target}.`}
          </p>
          <p className="mt-1 text-muted">Dans la partie : {m.san}{m.mark}. {m.comment}</p>
          <div className="mt-2 flex gap-3 text-xs">
            <button type="button" onClick={() => { setAnswer(null); setI(i + 1); }} className="neon-btn rounded-lg px-3 py-1 font-semibold">{i + 1 < review.quiz.length ? "Position suivante" : "Voir mon score"}</button>
            <button type="button" onClick={() => onGo(ply - 1)} className="text-neon hover:underline">Voir sur le grand échiquier</button>
          </div>
        </div>
      )}
    </div>
  );
}
