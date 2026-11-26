"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "../../../../components/PageHeader";
import { GameBoard } from "../../../../components/GameBoard";
import { MoveNav } from "../../../../components/MoveNav";
import { useSettings } from "../../../../lib/settings";
import { replayFromSans } from "../../../../lib/replay";
import { repertoireById, type RepertoireDef, type RepLine } from "../../../../lib/repertoireBook";
import { frenchOpening, loadOpeningBook, type OpeningBook } from "../../../../lib/openingBook";

/** PGN du répertoire : une partie par sous-ligne (ChessBase, Lichess et les autres logiciels les lisent). */
function toPgn(sections: RepertoireDef[]): string {
  return sections.flatMap((r) => r.lines.map((l) => {
    const sans = l.moves.split(" ");
    const body = sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(" ");
    return `[Event "Répertoire ChessAurum : ${r.title}"]\n[Site "ChessAurum"]\n[White "${r.side === "w" ? "Répertoire" : "?"}"]\n[Black "${r.side === "b" ? "Répertoire" : "?"}"]\n[Result "*"]\n[Annotator "ChessAurum"]\n\n{ ${l.name}. ${l.note.replace(/[{}]/g, "")} } ${body} *\n`;
  })).join("\n");
}

export default function RepertoireBookPage() {
  const { id } = useParams<{ id: string }>();
  const [settings] = useSettings();
  const rep = repertoireById(id);
  const sections = useMemo(() => (rep ? [rep, ...(rep.with ?? []).map(repertoireById).filter((x): x is RepertoireDef => !!x)] : []), [rep]);
  const [sel, setSel] = useState<{ s: number; l: number }>({ s: 0, l: 0 });
  const [ply, setPly] = useState(-1);
  const [book, setBook] = useState<OpeningBook | null>(null);
  useEffect(() => { void loadOpeningBook().then(setBook); }, []);

  const line: RepLine | undefined = sections[sel.s]?.lines[sel.l];
  const steps = useMemo(() => (line ? replayFromSans(line.moves.split(" ")) : []), [line]);
  const last = steps.length - 1;
  const cur = ply < 0 || ply > last ? last : ply;
  useEffect(() => { setPly(-1); }, [sel]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, (p < 0 ? last : p) - 1));
      if (e.key === "ArrowRight") setPly((p) => Math.min(last, (p < 0 ? last : p) + 1));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [last]);
  const name = book && steps[cur] ? (() => {
    for (let i = cur; i >= 0; i--) { const e = book.lookup(steps[i]!.fen); if (e) return `${frenchOpening(e.name)} (${e.eco})`; }
    return null;
  })() : null;

  if (!rep) return <main className="arena-app"><PageHeader title="Répertoire" active="/repertoire" /><p className="p-6 text-muted">Répertoire introuvable.</p></main>;
  const download = () => {
    const blob = new Blob([toPgn(sections)], { type: "application/x-chess-pgn" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `repertoire-${rep.id}.pgn`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const side = rep.side;
  return (
    <main className="arena-app pb-10">
      <PageHeader title="Répertoire" active="/repertoire" />
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-2 sm:px-3 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start lg:px-6">
        {/* échiquier : collé en haut sur téléphone pendant qu'on parcourt les lignes */}
        <div className="flex min-w-0 flex-col gap-2 max-lg:sticky max-lg:top-0 max-lg:z-30 max-lg:-mx-2 max-lg:border-b max-lg:border-line max-lg:bg-ink max-lg:px-2 max-lg:pb-1.5 max-lg:pt-1">
          <section data-board className="mx-auto flex w-full flex-col gap-1.5 max-w-[min(100%,42dvh)] sm:max-w-[min(100%,50dvh)] lg:max-w-[min(100%,max(320px,calc(100dvh_-_220px)))]">
            {steps[cur] && (
              <GameBoard fen={steps[cur]!.fen} serverFen={steps[cur]!.fen} orientation={side} myColor={side} interactive={false} myTurn={false}
                lastMove={steps[cur]!.uci} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
                onMove={() => false} onCancelPremoves={() => {}} />
            )}
            <MoveNav compact ply={cur} last={last} go={(p) => setPly(Math.max(0, Math.min(last, p)))} />
            <p className="truncate text-center text-xs text-muted">{name ?? " "}</p>
          </section>
        </div>
        <aside className="flex min-w-0 flex-col gap-3">
          <section className="panel p-3">
            <p className="text-xs text-muted">{side === "w" ? "Répertoire avec les Blancs" : "Répertoire avec les Noirs"}</p>
            <h1 className="font-display text-lg font-bold">{rep.title}</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed">{rep.summary}</p>
            <h2 className="mt-2 text-xs font-semibold text-gold">Les idées à retenir</h2>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[13px]">{rep.ideas.map((x) => <li key={x}>{x}</li>)}</ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={download} className="rounded-lg border border-neon/50 px-3 py-1.5 text-xs font-semibold text-neon">⬇ PGN du répertoire ({sections.reduce((n, r) => n + r.lines.length, 0)} lignes)</button>
              <a href={`/analyse?m=${steps.slice(1, cur + 1).map((x) => x.uci).join(",")}`} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:text-text">Analyser cette position</a>
            </div>
          </section>
          {sections.map((r, si) => (
            <section key={r.id} className="panel p-3" aria-label={r.title}>
              {si > 0 && <><h2 className="font-display text-sm font-bold">{r.title}</h2><p className="mb-2 text-xs text-muted">{r.summary}</p></>}
              <ol className="flex flex-col gap-1.5">
                {r.lines.map((l, li) => {
                  const active = sel.s === si && sel.l === li;
                  const sans = l.moves.split(" ");
                  return (
                    <li key={l.name} className={`rounded-lg border p-2 ${active ? "border-neon/50 bg-neon/5" : "border-line"}`}>
                      <button type="button" onClick={() => setSel({ s: si, l: li })} className="w-full text-left">
                        <span className="block text-sm font-semibold">{l.name}</span>
                        {!active && <span className="block truncate text-xs text-muted">{sans.slice(0, 10).map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(" ")}…</span>}
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
          <p className="px-1 text-[11px] text-muted">Lignes vérifiées par Stockfish (aucun coup du répertoire ne perd plus d'un pion). Noms des variantes : base libre lichess-org/chess-openings.</p>
        </aside>
      </div>
    </main>
  );
}
