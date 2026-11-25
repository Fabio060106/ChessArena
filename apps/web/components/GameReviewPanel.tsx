"use client";
import { useEffect, useMemo, useState } from "react";
import { Engine, ENGINE_NAME, terminalScore } from "../lib/engine";
import { buildReview, reviewKey, toEval, type GameReview, type PositionEval } from "../lib/gameReview";
import { replayFromSans } from "../lib/replay";

/** Profondeur de l'analyse d'après-partie : assez pour repérer les erreurs, rapide même sur téléphone. */
const REVIEW_DEPTH = 13;

const MARK_CLS: Record<string, string> = { "??": "text-danger", "?": "text-[#fb923c]", "?!": "text-gold" };

/**
 * Dès qu'une partie retransmise est terminée, Stockfish (dans le navigateur) l'analyse en entier :
 * résumé, précision de chaque joueur, moments clés avec le meilleur coup, courbe cliquable.
 * Le résultat est gardé sur l'appareil : revenir sur la page ne relance pas le calcul.
 */
export function GameReviewPanel({ cacheKey, sans, ucis, names, result, onGo }: {
  cacheKey: { relayId: string; round: number | null; index: number };
  sans: readonly string[];
  ucis: readonly string[];
  names: { w: string; b: string };
  result: string | null;
  onGo: (ply: number) => void;
}) {
  const key = reviewKey(cacheKey.relayId, cacheKey.round, cacheKey.index, sans.length);
  const steps = useMemo(() => replayFromSans(sans), [sans]);
  const [review, setReview] = useState<GameReview | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setReview(null); setFailed(false);
    try {
      const cached = localStorage.getItem(key);
      if (cached) { setReview(JSON.parse(cached) as GameReview); return; }
    } catch { /* cache illisible : on recalcule */ }
    let engine: Engine | null = null;
    let live = true;
    try { engine = new Engine(); } catch { setFailed(true); return; }
    (async () => {
      const fens = steps.map((s) => s.fen);
      const evals: PositionEval[] = [];
      setProgress({ done: 0, total: fens.length });
      for (let i = 0; i < fens.length; i++) {
        const t = terminalScore(fens[i]!);
        const l = t ? null : await engine!.analyse(fens[i]!, REVIEW_DEPTH);
        if (!live) return;
        const e = toEval(l, t);
        if (!e) { setFailed(true); return; }
        evals.push(e);
        setProgress({ done: i + 1, total: fens.length });
      }
      const r = buildReview({ sans, fens, evals, names, result });
      setReview(r); setProgress(null);
      try { localStorage.setItem(key, JSON.stringify(r)); } catch { /* stockage plein : sans conséquence */ }
    })().catch(() => setFailed(true));
    return () => { live = false; engine?.terminate(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (failed) return <p className="panel p-3 text-sm text-muted">L'analyse automatique n'a pas pu se lancer sur cet appareil. Utilise « Analyser cette position ».</p>;
  if (!review) {
    const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <section className="panel p-3" aria-label="Analyse Stockfish de la partie">
        <p className="text-sm font-semibold">Partie terminée : {ENGINE_NAME} l'analyse…</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-2"><div className="h-full bg-neon transition-all" style={{ width: `${pct}%` }} /></div>
        <p className="tabular mt-1 text-xs text-muted">{progress ? `${progress.done} / ${progress.total} positions` : "Démarrage du moteur…"}</p>
      </section>
    );
  }
  const n = review.curve.length - 1;
  return (
    <section className="panel flex flex-col gap-3 p-3" aria-label="Analyse Stockfish de la partie">
      <div>
        <p className="text-sm font-semibold"><span className="text-neon">{ENGINE_NAME}</span> · analyse de la partie</p>
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
            {review.moments.map((m) => (
              <li key={m.ply} className="rounded-lg bg-surface-2 p-2 text-sm">
                <button type="button" onClick={() => onGo(m.ply)} className="font-semibold hover:underline">
                  {m.move}<span className={`ml-0.5 ${MARK_CLS[m.mark] ?? ""}`}>{m.mark}</span>
                </button>
                <span className="ml-1 text-muted">{m.text}</span>
                {m.line && <span className="mt-0.5 block text-xs text-muted">Suite proposée : {m.line}</span>}
                <span className="mt-1 flex gap-3 text-xs">
                  <button type="button" onClick={() => onGo(m.ply - 1)} className="text-neon hover:underline">Voir la position</button>
                  <a href={`/analyse?m=${ucis.slice(0, m.ply - 1).join(",")}`} className="text-neon hover:underline">Essayer d'autres coups</a>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : <p className="text-sm text-muted">Aucune erreur notable : les deux joueurs ont trouvé de bons coups toute la partie.</p>}
      <p className="text-[11px] text-muted/80">Analyse calculée dans ton navigateur (profondeur {REVIEW_DEPTH}), gardée sur cet appareil.</p>
    </section>
  );
}
