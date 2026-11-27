"use client";
import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { RepertoireGame } from "@chessarena/shared";
import { frenchOpening, loadOpeningBook, type OpeningBook } from "../lib/openingBook";
import { TEACHING_VERSION } from "../lib/pedagogy";

const SRC: Record<string, string> = { site: "ChessAurum", lichess: "Lichess", pgn: "PGN" };
const PAGE = 20;

/** Nom de l'ouverture d'une partie : en-tête Opening du PGN, sinon la position nommée la plus avancée du livre. */
function openingOf(pgn: string, book: OpeningBook | null): string | null {
  const tag = /\[Opening "([^"]+)"\]/.exec(pgn)?.[1];
  if (tag) return frenchOpening(tag);
  if (!book) return null;
  try {
    const c = new Chess();
    c.loadPgn(pgn);
    const moves = c.history();
    const r = new Chess();
    let name: string | null = null;
    for (const san of moves.slice(0, 30)) { r.move(san); const e = book.lookup(r.fen()); if (e) name = e.name; }
    return name ? frenchOpening(name) : null;
  } catch { return null; }
}

const analysed = (id: string) => {
  try {
    const p = `arena.teach${TEACHING_VERSION}.own.${id}.`;
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(p)) return true;
  } catch { /* stockage indisponible */ }
  return false;
};

/** Les parties du joueur, des plus récentes aux plus anciennes, chacune ouvrable en partie commentée coup par coup. */
export function OwnGamesList({ games }: { games: readonly RepertoireGame[] }) {
  const [src, setSrc] = useState<"all" | "site" | "lichess" | "pgn">("all");
  const [lossOnly, setLossOnly] = useState(false);
  const [n, setN] = useState(PAGE);
  const [book, setBook] = useState<OpeningBook | null>(null);
  useEffect(() => { void loadOpeningBook().then(setBook); }, []);
  const list = useMemo(() => [...games]
    .filter((g) => (src === "all" || (g.source ?? "site") === src) && (!lossOnly || g.outcome === "loss"))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt)), [games, src, lossOnly]);
  const shown = useMemo(() => list.slice(0, n), [list, n]);
  const names = useMemo(() => new Map(shown.map((g) => [g.gameId, openingOf(g.pgn, book)])), [shown, book]);
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => { setDone(new Set(shown.filter((g) => analysed(g.gameId)).map((g) => g.gameId))); }, [shown]);
  const has = (s: string) => games.some((g) => (g.source ?? "site") === s);

  return (
    <section className="panel flex flex-col gap-3 p-3" aria-label="Mes parties">
      <div>
        <h2 className="font-display text-base font-semibold">Mes parties commentées</h2>
        <p className="text-xs text-muted">Ouvre une partie : Stockfish l'analyse et chaque coup est expliqué, comme dans un livre. Commence par tes défaites : c'est là qu'on apprend le plus.</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "site", "lichess", "pgn"] as const).filter((s) => s === "all" || has(s)).map((s) => (
          <button key={s} type="button" aria-pressed={src === s} onClick={() => { setSrc(s); setN(PAGE); }}
            className={`rounded-full border px-2.5 py-1 text-xs ${src === s ? "border-neon bg-neon/15 text-text" : "border-line text-muted hover:text-text"}`}>{s === "all" ? "Toutes" : SRC[s]}</button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={lossOnly} onChange={(e) => { setLossOnly(e.target.checked); setN(PAGE); }} /> Défaites seulement
        </label>
      </div>
      {!list.length ? <p className="text-sm text-muted">Aucune partie pour l'instant : joue sur le site ou importe tes parties ci-dessus.</p> : (
        <ul className="flex flex-col divide-y divide-line">
          {shown.map((g) => (
            <li key={g.gameId}>
              <a href={`/repertoire/partie/${encodeURIComponent(g.gameId)}`} className="flex items-center gap-2 py-2 hover:bg-surface-2/60">
                <span className={`size-3 shrink-0 rounded-sm border border-line ${g.color === "w" ? "bg-[#f3f3f3]" : "bg-[#222]"}`} aria-label={g.color === "w" ? "Blancs" : "Noirs"} />
                <span className={`w-6 shrink-0 text-center text-xs font-bold ${g.outcome === "win" ? "text-win" : g.outcome === "loss" ? "text-danger" : "text-muted"}`}>{g.outcome === "win" ? "1" : g.outcome === "loss" ? "0" : "½"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{g.opponent}</span>
                  <span className="block truncate text-xs text-muted">{names.get(g.gameId) ?? "Ouverture"} · {new Date(g.endedAt).toLocaleDateString("fr-FR")} · {SRC[g.source ?? "site"]}</span>
                </span>
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${done.has(g.gameId) ? "text-muted" : "text-neon"}`}>{done.has(g.gameId) ? "Relire" : "Analyser →"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {list.length > n && <button type="button" onClick={() => setN((x) => x + PAGE)} className="self-center text-sm text-neon hover:underline">Plus de parties ({list.length - n})</button>}
    </section>
  );
}
