"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepertoireGame } from "@chessarena/shared";
import { buildProfile, recommend, ucisOf, type Slot } from "../lib/openingAdvisor";
import { buildStyle, deepAnalyse, type DeepStats } from "../lib/styleAnalysis";
import { Engine, terminalScore } from "../lib/engine";

const DEEP_GAMES = 20;
const DEEP_DEPTH = 9;

const SLOTS: Array<[Slot, string]> = [["w", "Avec les Blancs"], ["b-e4", "Noirs contre 1.e4"], ["b-d4", "Noirs contre 1.d4"]];
const MIN_GAMES = 10;

/** « Ouvertures conseillées pour toi » : profil du joueur (niveau, style, forces, faiblesses) et ouvertures adaptées. */
export function OpeningAdvice({ games }: { games: readonly RepertoireGame[] }) {
  const profile = useMemo(() => (games.length >= MIN_GAMES ? buildProfile(games) : null), [games]);
  // analyse approfondie (Stockfish) : gardée sur l'appareil pour ces parties-là
  const deepKey = useMemo(() => `arena.style1.${[...games].sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, DEEP_GAMES).map((g) => g.gameId).join(",").slice(0, 400)}`, [games]);
  const [deep, setDeep] = useState<DeepStats | null>(null);
  const [deepProgress, setDeepProgress] = useState<number | null>(null);
  const cancel = useRef(false);
  useEffect(() => {
    try { const raw = localStorage.getItem(deepKey); setDeep(raw ? (JSON.parse(raw) as DeepStats) : null); } catch { setDeep(null); }
  }, [deepKey]);
  useEffect(() => () => { cancel.current = true; }, []);
  const runDeep = async () => {
    let engine: Engine | null = null;
    try { engine = new Engine(); } catch { return; }
    cancel.current = false;
    setDeepProgress(0);
    const res = await deepAnalyse(games, async (fen) => {
      const t = terminalScore(fen);
      return t ? { depth: 0, score: t, pv: [] } : engine!.analyse(fen, DEEP_DEPTH);
    }, { maxGames: DEEP_GAMES, onProgress: (d, t) => setDeepProgress(Math.round((100 * d) / t)), cancelled: () => cancel.current }).catch(() => null);
    engine.terminate();
    setDeepProgress(null);
    if (res) { setDeep(res); try { localStorage.setItem(deepKey, JSON.stringify(res)); } catch { /* plein */ } }
  };
  const style = useMemo(() => (profile ? buildStyle(games, deep) : null), [profile, games, deep]);
  const advice = useMemo(() => (profile ? SLOTS.map(([slot, label]) => ({ slot, label, list: recommend(profile, slot, 2, style) })) : []), [profile, style]);
  const [slot, setSlot] = useState<Slot>("w");
  if (!profile) {
    return (
      <section className="panel mb-3 p-3" aria-label="Ouvertures conseillées pour toi">
        <h2 className="font-display text-sm font-bold">Ouvertures conseillées pour toi</h2>
        <p className="mt-1 text-xs text-muted">Il faut au moins {MIN_GAMES} parties (jouées ici ou importées de Lichess) pour analyser ton jeu. Tu en as {games.length}.</p>
      </section>
    );
  }
  const cur = advice.find((a) => a.slot === slot)!;
  return (
    <section className="panel mb-3 flex flex-col gap-3 p-3" aria-label="Ouvertures conseillées pour toi">
      <div>
        <h2 className="font-display text-base font-bold">Ouvertures conseillées pour toi</h2>
        <p className="text-xs text-muted">D'après l'analyse de tes {profile.games} parties : ton niveau, ton style, tes résultats par ouverture.</p>
      </div>
      {/* le profil */}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-2 p-2.5">
          <p className="text-xs text-muted">Niveau</p>
          <p className="font-semibold">{profile.level}{profile.rating ? <span className="tabular ml-1 text-sm font-normal text-muted">(~{profile.rating})</span> : null}</p>
          <p className="tabular mt-0.5 text-xs text-muted">Blancs {profile.score.w ?? "–"} % · Noirs {profile.score.b ?? "–"} %</p>
        </div>
        <div className="rounded-lg bg-surface-2 p-2.5">
          <p className="text-xs text-muted">Style</p>
          <p className="font-semibold">{profile.style}</p>
          <div className="mt-1.5 h-1.5 rounded bg-ink" aria-label={`Style : ${Math.round(profile.sharp * 100)} % tactique`}>
            <div className="h-full rounded bg-gradient-to-r from-neon to-danger" style={{ width: `${Math.round(profile.sharp * 100)}%` }} />
          </div>
          <p className="mt-0.5 flex justify-between text-[11px] text-muted"><span>positionnel</span><span>tactique</span></p>
        </div>
        <div className="rounded-lg bg-surface-2 p-2.5">
          <p className="text-xs text-muted">Contre 1.e4 / 1.d4 (Noirs)</p>
          <p className="tabular font-semibold">{profile.vsE4.score ?? "–"} % <span className="text-xs font-normal text-muted">({profile.vsE4.games} p.)</span> · {profile.vsD4.score ?? "–"} % <span className="text-xs font-normal text-muted">({profile.vsD4.games} p.)</span></p>
        </div>
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold text-win">Tes forces</h3>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px]">{(profile.strengths.length ? profile.strengths : ["Pas encore assez de parties pour en dégager."]).map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold text-danger">À travailler</h3>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px]">{(profile.weaknesses.length ? profile.weaknesses : ["Rien de marquant : continue comme ça."]).map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      </div>
      {/* le style, lu dans les parties */}
      {style && (
        <div className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-sm font-bold">Ton style d'après tes parties</h3>
            {deep ? <span className="text-[11px] text-muted">analyse Stockfish de {deep.games} parties</span> : null}
            <button type="button" disabled={deepProgress !== null} onClick={() => void runDeep()}
              className="ml-auto rounded-lg border border-neon/50 px-2.5 py-1 text-xs font-semibold text-neon disabled:opacity-60">
              {deepProgress !== null ? `Analyse en cours… ${deepProgress} %` : deep ? "Relancer l'analyse Stockfish" : "Analyse approfondie (Stockfish, ~2 min)"}
            </button>
          </div>
          <div className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {style.axes.map((a) => (
              <div key={a.id} title={a.hint}>
                <div className="flex justify-between text-xs"><span>{a.label}</span><span className="tabular text-muted">{a.value === null ? "—" : `${a.value}/100`}</span></div>
                <div className="mt-0.5 h-1.5 rounded bg-surface-2"><div className={`h-full rounded ${a.value === null ? "" : a.id === "attack" || a.id === "risk" ? "bg-neon" : a.value >= 60 ? "bg-win" : a.value >= 40 ? "bg-gold" : "bg-danger"}`} style={{ width: `${a.value ?? 0}%` }} /></div>
              </div>
            ))}
          </div>
          {!deep && <p className="mt-2 text-[11px] text-muted">Les notes « Ouverture », « Milieu de jeu » et « Défense » demandent l'analyse approfondie : Stockfish rejoue tes {DEEP_GAMES} dernières parties pour mesurer où tu perds des points.</p>}
          {style.findings.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-[13px]">
              {style.findings.map((f) => <li key={f} className="border-l-2 border-neon/40 pl-2">{f}</li>)}
            </ul>
          )}
        </div>
      )}
      {/* les ouvertures conseillées */}
      <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Conseils pour">
        {SLOTS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={slot === k} onClick={() => setSlot(k)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold sm:text-sm ${slot === k ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>{label}</button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {cur.list.map((a, i) => (
          <article key={a.option.id} className={`rounded-lg border p-3 ${i === 0 ? "border-neon/50" : "border-line"}`}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{i === 0 ? "Notre premier choix" : "Autre option"} · {a.current && a.current.games >= 4 && a.current.score >= 50 ? <span className="text-win">à garder</span> : <span className="text-neon">nouvelle</span>}</p>
            <h3 className="font-display text-base font-bold">{a.option.name}</h3>
            <p className="tabular mt-0.5 text-xs text-muted">{a.option.moves.split(" ").map((s, j) => (j % 2 === 0 ? `${j / 2 + 1}.${s}` : s)).join(" ")}</p>
            {a.reasons.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 text-[13px]">
                {a.reasons.map((r) => <li key={r}>✓ {r.charAt(0).toUpperCase() + r.slice(1)}</li>)}
              </ul>
            )}
            <p className="mt-2 text-[13px] leading-snug text-muted"><span className="font-semibold text-text">Le plan : </span>{a.option.plan}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a href={`/repertoire/livre/${a.option.id}${a.current && a.current.games >= 4 && a.current.score >= 50 ? "?statut=garder" : ""}`} className="rounded-lg bg-neon/15 px-2.5 py-1 text-xs font-semibold text-neon ring-1 ring-neon/50">Cours et répertoire complet →</a>
              <a href={`/analyse?m=${ucisOf(a.option.moves).join(",")}`} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-muted hover:text-text">Voir la ligne sur l'échiquier</a>
            </div>
          </article>
        ))}
      </div>
      <p className="text-[11px] text-muted">Recommandations calculées automatiquement à partir de tes parties ; plus tu en importes, plus elles sont précises.</p>
    </section>
  );
}
