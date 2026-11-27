"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { RepertoireResponse } from "@chessarena/shared";
import { PageHeader } from "../../../../components/PageHeader";
import { GameBoard } from "../../../../components/GameBoard";
import { MoveNav } from "../../../../components/MoveNav";
import { useSettings } from "../../../../lib/settings";
import { replayFromSans } from "../../../../lib/replay";
import { repertoireById, type RepertoireDef } from "../../../../lib/repertoireBook";
import { courseOf } from "../../../../lib/openingCourses";
import { buildExercises, buildTree, compareGames, learningPlan, type StudyReport } from "../../../../lib/repertoireStudy";
import { frenchOpening, loadOpeningBook, type OpeningBook } from "../../../../lib/openingBook";
import { loadWeapons, numbered as numberedFrom, weaponCoach, weaponExercises, weaponsFor, type Weapon } from "../../../../lib/weapons";
import { loadMasterMeta, masterModels, type MasterMeta, type MasterModels } from "../../../../lib/masterDb";

type Tab = "cours" | "lignes" | "armes" | "maitres" | "exercices" | "parties" | "plan";
const TABS: Array<[Tab, string]> = [["cours", "Cours"], ["lignes", "Lignes"], ["armes", "Armes secrètes"], ["maitres", "Maîtres"], ["exercices", "Exercices"], ["parties", "Mes parties"], ["plan", "Plan"]];

/** PGN du répertoire : une partie par sous-ligne (ChessBase, Lichess et les autres logiciels les lisent). */
function toPgn(sections: RepertoireDef[]): string {
  return sections.flatMap((r) => r.lines.map((l) => {
    const sans = l.moves.split(" ");
    const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
    return `[Event "Répertoire ChessAurum : ${r.title}"]\n[Site "ChessAurum"]\n[White "${r.side === "w" ? "Répertoire" : "?"}"]\n[Black "${r.side === "b" ? "Répertoire" : "?"}"]\n[Result "*"]\n[Annotator "ChessAurum"]\n\n{ ${l.name}. ${l.note.replace(/[{}]/g, "")} } ${body} *\n`;
  })).join("\n");
}
const numbered = (moves: string) => moves.split(" ").map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(" ");

export default function RepertoireBookPage() {
  return <Suspense fallback={null}><RepertoireBook /></Suspense>;
}

function RepertoireBook() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const [settings] = useSettings();
  const rep = repertoireById(id);
  const course = courseOf(id);
  const sections = useMemo(() => (rep ? [rep, ...(rep.with ?? []).map(repertoireById).filter((x): x is RepertoireDef => !!x)] : []), [rep]);
  const tree = useMemo(() => buildTree(sections), [sections]);
  // armes secrètes et surprises (préparées hors ligne avec Stockfish)
  const [weapons, setWeapons] = useState<Weapon[] | null>(null);
  useEffect(() => { void loadWeapons().then((f) => setWeapons(weaponsFor(f, sections.map((r) => r.id)))); }, [sections]);
  const exercises = useMemo(() => {
    const base: Array<{ fen: string; answers: string[]; answerSan: string; prompt: string; before: string; why?: string }> = rep ? buildExercises(rep, tree) : [];
    // les exercices d'armes secrètes s'intercalent (un sur trois) pour varier
    const extra = weaponExercises(weapons ?? []);
    const out: typeof base = [];
    for (let i = 0, j = 0; i < base.length || j < extra.length;) {
      if (i < base.length) out.push(base[i++]!);
      if (i < base.length) out.push(base[i++]!);
      if (j < extra.length) out.push(extra[j++]!);
    }
    return out;
  }, [rep, tree, weapons]);
  const [tab, setTab] = useState<Tab>(() => (TABS.some(([k]) => k === params.get("onglet")) ? params.get("onglet") as Tab : "cours"));
  // ce qui est affiché sur l'échiquier : une suite de coups, et le coup courant
  const [shown, setShown] = useState<{ moves: string; label: string } | null>(null);
  const [ply, setPly] = useState(-1);
  const [sel, setSel] = useState<{ s: number; l: number } | null>(null);
  const [book, setBook] = useState<OpeningBook | null>(null);
  const [study, setStudy] = useState<StudyReport | null>(null);
  const [studyState, setStudyState] = useState<"loading" | "ok" | "none">("loading");
  const [ex, setEx] = useState(0);
  const [answer, setAnswer] = useState<{ good: boolean } | null>(null);
  const [score, setScore] = useState({ ok: 0, done: 0 });
  useEffect(() => { void loadOpeningBook().then(setBook); }, []);
  // parties modèles (base de maîtres, si elle est installée)
  const [masters, setMasters] = useState<{ meta: MasterMeta | null; models: Record<string, MasterModels> } | null>(null);
  useEffect(() => {
    if (tab !== "maitres" || masters) return;
    void (async () => {
      const meta = await loadMasterMeta();
      const models: Record<string, MasterModels> = {};
      if (meta) for (const r of sections) { const m = await masterModels(r.id); if (m) models[r.id] = m; }
      setMasters({ meta, models });
    })();
  }, [tab, masters, sections]);
  useEffect(() => {
    if (!rep) return;
    void fetch("/api/repertoire", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as RepertoireResponse) : null))
      .then((d) => { if (d) { setStudy(compareGames(rep, tree, d.games)); setStudyState("ok"); } else setStudyState("none"); })
      .catch(() => setStudyState("none"));
  }, [rep, tree]);
  // première ligne affichée par défaut
  useEffect(() => { if (rep && !shown) setShown({ moves: course?.structures[0]?.moves ?? rep.lines[0]!.moves, label: course?.structures[0]?.title ?? rep.lines[0]!.name }); }, [rep, course, shown]);

  const steps = useMemo(() => (shown ? replayFromSans(shown.moves.split(" ")) : replayFromSans([])), [shown]);
  const last = steps.length - 1;
  const cur = ply < 0 || ply > last ? last : ply;
  const show = (moves: string, label: string, at = -1) => { setShown({ moves, label }); setPly(at); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (tab === "exercices") return;
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, (p < 0 ? last : p) - 1));
      if (e.key === "ArrowRight") setPly((p) => Math.min(last, (p < 0 ? last : p) + 1));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [last, tab]);
  const name = book && steps[cur] ? (() => {
    for (let i = cur; i >= 0; i--) { const e = book.lookup(steps[i]!.fen); if (e) return `${frenchOpening(e.name)} (${e.eco})`; }
    return null;
  })() : null;

  if (!rep) return <main className="arena-app"><PageHeader title="Répertoire" active="/repertoire" /><p className="p-6 text-muted">Répertoire introuvable.</p></main>;
  const side = rep.side;
  const mode: "keep" | "new" = params.get("statut") === "garder" || (study && study.games >= 5 && study.elsewhere < study.games) ? "keep" : "new";
  const plan = learningPlan(rep, mode, study, sections.slice(1).reduce((n, r) => n + r.lines.length, 0));
  const exo = tab === "exercices" ? exercises[ex] : undefined;
  const boardFen = exo ? exo.fen : steps[cur]?.fen ?? steps[0]!.fen;
  const tryMove = (from: string, to: string, promotion?: string) => {
    if (!exo || answer) return false;
    const good = exo.answers.some((u) => u.slice(0, 4) === from + to);
    setAnswer({ good });
    setScore((s) => ({ ok: s.ok + (good ? 1 : 0), done: s.done + 1 }));
    void promotion;
    return false;
  };
  const download = () => {
    const blob = new Blob([toPgn(sections)], { type: "application/x-chess-pgn" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `repertoire-${rep.id}.pgn`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const card = "rounded-lg border border-line p-2.5";
  const showBtn = (moves: string, label: string) => (
    <button type="button" onClick={() => show(moves, label)} className="mt-1 text-xs font-semibold text-neon hover:underline">Voir sur l'échiquier</button>
  );

  return (
    <main className="arena-app pb-10">
      <PageHeader title="Répertoire" active="/repertoire" />
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-2 sm:px-3 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start lg:px-6">
        {/* échiquier : collé en haut sur téléphone pendant la lecture */}
        <div className="flex min-w-0 flex-col gap-2 max-lg:sticky max-lg:top-0 max-lg:z-30 max-lg:-mx-2 max-lg:border-b max-lg:border-line max-lg:bg-ink max-lg:px-2 max-lg:pb-1.5 max-lg:pt-1">
          <section data-board className="mx-auto flex w-full flex-col gap-1.5 max-w-[min(100%,42dvh)] sm:max-w-[min(100%,50dvh)] lg:max-w-[min(100%,max(320px,calc(100dvh_-_220px)))]">
            <GameBoard fen={boardFen} serverFen={boardFen} orientation={side} myColor={side} interactive={!!exo && !answer} myTurn={!!exo}
              lastMove={exo ? null : steps[cur]?.uci ?? null} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
              autoQueen onMove={tryMove} onCancelPremoves={() => {}}
              arrows={exo && answer ? [{ from: exo.answers[0]!.slice(0, 2), to: exo.answers[0]!.slice(2, 4), color: "#22c55e" }] : []} />
            {!exo && <MoveNav compact ply={cur} last={last} go={(p) => setPly(Math.max(0, Math.min(last, p)))} />}
            <p className="truncate text-center text-xs text-muted">{exo ? exo.before : `${shown?.label ?? ""}${name ? ` · ${name}` : ""}`}</p>
          </section>
        </div>
        <aside className="flex min-w-0 flex-col gap-3">
          <section className="panel p-3">
            <p className="text-xs text-muted">{side === "w" ? "Répertoire avec les Blancs" : "Répertoire avec les Noirs"} · {mode === "keep" ? "ouverture à garder et approfondir" : "nouvelle ouverture à apprendre"}</p>
            <h1 className="font-display text-lg font-bold">{rep.title}</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed">{rep.summary}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={download} className="rounded-lg border border-neon/50 px-3 py-1.5 text-xs font-semibold text-neon">⬇ PGN ({sections.reduce((n, r) => n + r.lines.length, 0)} lignes)</button>
              <a href={`/analyse?m=${(exo ? [] : steps.slice(1, cur + 1).map((x) => x.uci)).join(",")}`} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:text-text">Analyser cette position</a>
            </div>
          </section>
          <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-surface-2 p-0.5 lg:flex" role="tablist" aria-label="Étude de l'ouverture">
            {TABS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setAnswer(null); }}
                className={`flex-1 rounded-md px-1 py-1.5 text-xs font-semibold sm:text-sm ${tab === k ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>{label}</button>
            ))}
          </div>

          {tab === "cours" && (
            <div className="flex flex-col gap-3" aria-label="Cours">
              <section className="panel p-3">
                <h2 className="font-display text-sm font-bold text-gold">Les idées à retenir</h2>
                <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[13.5px]">{rep.ideas.map((x) => <li key={x}>{x}</li>)}</ul>
              </section>
              {course && (
                <>
                  <section className="panel flex flex-col gap-2 p-3">
                    <h2 className="font-display text-sm font-bold text-gold">Les structures de pions</h2>
                    {course.structures.map((st) => (
                      <div key={st.title} className={card}>
                        <h3 className="text-sm font-semibold">{st.title}</h3>
                        <p className="text-xs text-muted">{numbered(st.moves)}</p>
                        <p className="mt-1 font-serif text-[14px] leading-relaxed">{st.text}</p>
                        {showBtn(st.moves, st.title)}
                      </div>
                    ))}
                  </section>
                  <section className="panel grid gap-3 p-3 sm:grid-cols-2">
                    <div>
                      <h2 className="font-display text-sm font-bold text-win">Tes plans</h2>
                      <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[13px]">{course.plans.me.map((x) => <li key={x}>{x}</li>)}</ul>
                    </div>
                    <div>
                      <h2 className="font-display text-sm font-bold text-danger">Les plans de l'adversaire</h2>
                      <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[13px]">{course.plans.them.map((x) => <li key={x}>{x}</li>)}</ul>
                    </div>
                  </section>
                  <section className="panel p-3">
                    <h2 className="font-display text-sm font-bold text-gold">Les erreurs à éviter</h2>
                    <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[13px]">{course.mistakes.map((x) => <li key={x}>{x}</li>)}</ul>
                  </section>
                  {course.traps.length > 0 && (
                    <section className="panel flex flex-col gap-2 p-3">
                      <h2 className="font-display text-sm font-bold text-gold">Les pièges à connaître</h2>
                      {course.traps.map((t) => (
                        <div key={t.name} className={card}>
                          <h3 className="text-sm font-semibold">{t.name} <span className="text-xs font-normal text-muted">· {t.winner === side ? "pour toi" : "à éviter"}</span></h3>
                          <p className="text-xs text-muted">{numbered(t.moves)}</p>
                          <p className="mt-1 font-serif text-[14px] leading-relaxed">{t.text}</p>
                          {showBtn(t.moves, t.name)}
                        </div>
                      ))}
                      <p className="text-[11px] text-muted">Chaque piège a été vérifié par Stockfish.</p>
                    </section>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "lignes" && sections.map((r, si) => (
            <section key={r.id} className="panel p-3" aria-label={r.title}>
              {si > 0 && <><h2 className="font-display text-sm font-bold">{r.title}</h2><p className="mb-2 text-xs text-muted">{r.summary}</p></>}
              <ol className="flex flex-col gap-1.5">
                {r.lines.map((l, li) => {
                  const active = sel?.s === si && sel.l === li;
                  const sans = l.moves.split(" ");
                  return (
                    <li key={l.name} className={`rounded-lg border p-2 ${active ? "border-neon/50 bg-neon/5" : "border-line"}`}>
                      <button type="button" onClick={() => { setSel({ s: si, l: li }); show(l.moves, l.name); }} className="w-full text-left">
                        <span className="block text-sm font-semibold">{l.name}</span>
                        {!active && <span className="block truncate text-xs text-muted">{numbered(sans.slice(0, 10).join(" "))}…</span>}
                      </button>
                      {active && (
                        <>
                          <p className="mt-1 flex flex-wrap gap-x-1 gap-y-0.5 text-[13px]">
                            {sans.map((s, i) => (
                              <span key={i} className="whitespace-nowrap">
                                {i % 2 === 0 && <span className="text-muted">{i / 2 + 1}.</span>}
                                <button type="button" onClick={() => setPly(i + 1)} className={`rounded px-0.5 font-semibold ${cur === i + 1 ? "bg-neon/20 text-neon" : "hover:bg-surface-2"}`}>{s}</button>
                              </span>
                            ))}
                          </p>
                          <p className="mt-1.5 border-l-2 border-gold/50 pl-2 font-serif text-[14px] leading-relaxed">{l.note}</p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}

          {tab === "armes" && (
            <section className="panel flex flex-col gap-3 p-3" aria-label="Armes secrètes">
              {weapons === null ? <p className="text-sm text-muted">Chargement…</p> : !weapons.length ? (
                <p className="text-sm text-muted">Pas encore d'arme secrète repérée pour ce répertoire.</p>
              ) : (
                <>
                  <p className="text-xs text-muted">Des coups rares que Stockfish juge solides, choisis pour les problèmes pratiques qu'ils posent : peu de bonnes réponses, des réponses naturelles qui perdent. Et les surprises que tes adversaires peuvent te faire, avec l'antidote.</p>
                  {(["arme", "alerte"] as const).map((kind) => {
                    const list = weapons.filter((w) => w.kind === kind);
                    if (!list.length) return null;
                    return (
                      <div key={kind} className="flex flex-col gap-2">
                        <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-neon">{kind === "arme" ? "Tes armes secrètes" : "Surprises à connaître"}</h2>
                        {list.map((w) => <WeaponCard key={w.fen + w.uci} w={w} onShow={show} active={shown?.label === weaponLabel(w)} />)}
                      </div>
                    );
                  })}
                  <button type="button" onClick={() => { const i = exercises.findIndex((e) => !!e.why); setTab("exercices"); setAnswer(null); setEx(Math.max(0, i)); }} className="neon-btn self-start rounded-lg px-3 py-1.5 text-sm font-semibold">S'entraîner sur ces armes</button>
                </>
              )}
            </section>
          )}

          {tab === "maitres" && (
            <section className="panel flex flex-col gap-2 p-3" aria-label="Parties modèles">
              {!masters && <p className="text-sm text-muted">Chargement…</p>}
              {masters && !masters.meta && (
                <p className="text-sm text-muted">Les parties modèles arrivent bientôt : pour chaque ligne de ce répertoire, tu pourras rejouer les meilleures parties de grands maîtres, en partant de la position de fin de ligne pour voir comment ils mènent le milieu de jeu.</p>
              )}
              {masters?.meta && (
                <>
                  <p className="text-xs text-muted">Pour chaque ligne : des parties de maîtres passées par sa position finale (ou quelques coups avant). L'échiquier s'ouvre en fin de ligne : avance coup par coup et demande-toi quel plan suit chaque camp. {masters.meta.source}.</p>
                  {sections.flatMap((r) => r.lines.map((l) => ({ r, l, games: masters.models[r.id]?.[l.name] ?? [] }))).filter((x) => x.games.length).map(({ r, l, games }) => (
                    <div key={r.id + l.name} className={card}>
                      <h3 className="text-sm font-semibold">{l.name}</h3>
                      <ul className="mt-1 flex flex-col gap-1">
                        {games.map((g, i) => {
                          const label = `${g.w} – ${g.b}${g.y ? `, ${g.y}` : ""}`;
                          const active = shown?.label === label && shown.moves === g.m.join(" ");
                          return (
                            <li key={i}>
                              <button type="button" onClick={() => show(g.m.join(" "), label, l.moves.split(" ").length)}
                                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] ${active ? "bg-neon/10 text-neon" : "hover:bg-surface-2"}`}>
                                <span className="min-w-0 flex-1 truncate">{g.w}{g.we ? ` (${g.we})` : ""} – {g.b}{g.be ? ` (${g.be})` : ""}<span className="text-muted">{g.ev ? ` · ${g.ev}` : ""}{g.y ? ` · ${g.y}` : ""}</span></span>
                                <span className="tabular shrink-0 text-xs font-semibold">{g.r === "1/2-1/2" ? "½-½" : g.r}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                  {!sections.some((r) => r.lines.some((l) => masters.models[r.id]?.[l.name]?.length)) && <p className="text-sm text-muted">La base ne contient pas encore de partie pour les lignes de ce répertoire.</p>}
                </>
              )}
            </section>
          )}

          {tab === "exercices" && (
            <section className="panel flex flex-col gap-2 p-3" aria-label="Exercices">
              {exo ? (
                <>
                  <p className="text-xs text-muted">Exercice {ex + 1} / {exercises.length} · réussis {score.ok}/{score.done}</p>
                  <p className="text-sm font-semibold">{exo.prompt}</p>
                  <p className="text-xs text-muted">Position après {exo.before}. Joue le coup sur l'échiquier.</p>
                  {answer && (
                    <p role="status" className={`text-sm font-semibold ${answer.good ? "text-win" : "text-danger"}`}>
                      {exo.why
                        ? (answer.good ? `Bravo : ${exo.answerSan} !` : `La réponse : ${exo.answerSan} (flèche verte).`)
                        : (answer.good ? `Bravo : ${exo.answerSan} est le coup du répertoire.` : `Le répertoire joue ${exo.answerSan} (flèche verte).`)}
                    </p>
                  )}
                  {answer && exo.why && <p className="text-xs text-muted">{exo.why}</p>}
                  <div className="flex flex-wrap gap-2">
                    {!answer && <button type="button" onClick={() => setAnswer({ good: false })} className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs">Voir la réponse</button>}
                    {answer && ex + 1 < exercises.length && <button type="button" onClick={() => { setAnswer(null); setEx(ex + 1); }} className="neon-btn rounded-lg px-3 py-1.5 text-xs font-semibold">Exercice suivant</button>}
                    {answer && ex + 1 >= exercises.length && <button type="button" onClick={() => { setAnswer(null); setEx(0); setScore({ ok: 0, done: 0 }); }} className="neon-btn rounded-lg px-3 py-1.5 text-xs font-semibold">Recommencer ({score.ok}/{score.done})</button>}
                  </div>
                </>
              ) : <p className="text-sm text-muted">Pas d'exercice pour ce répertoire.</p>}
            </section>
          )}

          {tab === "parties" && (
            <section className="panel flex flex-col gap-2 p-3" aria-label="Mes parties">
              {studyState === "loading" && <p className="text-sm text-muted">Lecture de tes parties…</p>}
              {studyState === "none" && <p className="text-sm text-muted">Connecte-toi et importe tes parties (page Répertoire) pour comparer ton jeu à ce répertoire.</p>}
              {study && study.games === 0 && <p className="text-sm">Tu n'as encore joué aucune partie dans cette ouverture{study.elsewhere ? ` (${study.elsewhere} parties de cette couleur avec d'autres ouvertures)` : ""}. Suis l'onglet « Plan » pour l'apprendre, puis reviens après quelques parties.</p>}
              {study && study.games > 0 && (
                <>
                  <p className="text-sm"><b>{study.games}</b> parties dans ce répertoire. Restées dans les lignes : <b>{study.followed}</b>{study.followedScore !== null ? ` (${study.followedScore} %)` : ""}{study.mineScore !== null ? ` · sorties de ton fait : ${study.mine.reduce((n, d) => n + d.count, 0)} (${study.mineScore} %)` : ""}.</p>
                  {study.mine.length > 0 && <h2 className="mt-1 text-xs font-semibold text-danger">Là où tu quittes le répertoire</h2>}
                  {study.mine.map((d) => (
                    <div key={d.epd + d.played} className={card}>
                      <p className="text-[13px]">Après <b>{d.before || "le début"}</b>, tu joues <b className="text-danger">{d.played}</b> ({d.count} fois, {d.score} %) ; le répertoire prévoit <b className="text-win">{d.expected.join(" ou ")}</b>.</p>
                      {showBtn(`${d.before.replace(/\d+\./g, "").trim()} ${d.played}`.trim(), `Ton coup : ${d.played}`)}
                    </div>
                  ))}
                  {study.theirs.length > 0 && <h2 className="mt-1 text-xs font-semibold text-gold">Les coups adverses que le répertoire ne couvre pas encore</h2>}
                  {study.theirs.map((d) => (
                    <div key={d.epd + d.played} className={card}>
                      <p className="text-[13px]">Après <b>{d.before || "le début"}</b>, ton adversaire joue <b>{d.played}</b> ({d.count} fois, ton score : {d.score} %).</p>
                      <a href={`/analyse?m=${replayFromSans([...d.before.replace(/\d+\./g, "").trim().split(" ").filter(Boolean), d.played]).slice(1).map((x) => x.uci).join(",")}`} className="mt-1 inline-block text-xs font-semibold text-neon hover:underline">Préparer une réponse sur l'échiquier d'analyse</a>
                    </div>
                  ))}
                </>
              )}
            </section>
          )}

          {tab === "plan" && (
            <section className="panel flex flex-col gap-2 p-3" aria-label="Plan d'apprentissage">
              <p className="text-xs text-muted">{mode === "keep" ? "Tu joues déjà cette ouverture : le plan part de tes parties." : "Une nouvelle ouverture : le plan pour l'apprendre pas à pas."}</p>
              {plan.map((s) => (
                <div key={s.title} className={card}>
                  <h3 className="text-sm font-semibold">{s.title}</h3>
                  <p className="mt-0.5 text-[13.5px] leading-relaxed">{s.text}</p>
                </div>
              ))}
            </section>
          )}
          <p className="px-1 text-[11px] text-muted">Lignes et pièges vérifiés par Stockfish. Noms des variantes : base libre lichess-org/chess-openings.</p>
        </aside>
      </div>
    </main>
  );
}

/** Légende sous l'échiquier : « Ligne — 5.a4!? ». */
const weaponLabel = (w: Weapon) => `${w.line} — ${numberedFrom([w.move], w.ply)}!?`;

/** Une arme secrète (ou une surprise adverse) expliquée comme par un entraîneur. */
function WeaponCard({ w, onShow, active }: { w: Weapon; onShow: (moves: string, label: string, at?: number) => void; active: boolean }) {
  const c = weaponCoach(w);
  const [open, setOpen] = useState(false);
  const line = [w.prefix, w.move, ...w.bestDefense].filter(Boolean).join(" ");
  return (
    <article className={`rounded-lg border p-2.5 ${active ? "border-neon/60" : "border-line"}`}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold">{c.title}</h3>
        <span className="shrink-0 rounded bg-neon/10 px-1.5 py-0.5 text-[11px] font-semibold text-neon" title="Note pratique : problèmes posés à l'adversaire, pièges, prix théorique">{w.score}/100</span>
      </div>
      <p className="mt-1 text-[13px]">{c.verdict}</p>
      {c.problem && <p className="mt-1 text-[13px]">{c.problem}</p>}
      {c.traps.length > 0 && (
        <div className="mt-1.5">
          <p className="text-xs font-semibold text-danger">{w.kind === "arme" ? "Les pièges" : "Ne tombe pas dans le piège"}</p>
          <ul className="mt-0.5 list-disc pl-4 text-[13px]">{c.traps.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      {open && (
        <div className="mt-1.5 text-[13px] text-muted">
          {c.idea && <p>{c.idea}</p>}
          <p className="mt-1">{c.follow}</p>
          <p className="mt-1">Ligne complète : {numberedFrom(line.split(" "), 0)}</p>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-3">
        <button type="button" onClick={() => onShow(line, weaponLabel(w), w.ply + 1)} className="text-xs font-semibold text-neon hover:underline">Voir sur l'échiquier</button>
        {w.traps[0] && <button type="button" onClick={() => onShow([w.prefix, w.move, w.traps[0]!.reply, ...w.traps[0]!.punish].join(" "), weaponLabel(w), w.ply + 2)} className="text-xs font-semibold text-neon hover:underline">Voir le piège</button>}
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-muted hover:text-text">{open ? "Moins" : "La suite à connaître"}</button>
      </div>
    </article>
  );
}
