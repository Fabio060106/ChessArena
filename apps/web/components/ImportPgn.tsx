"use client";
import { useState } from "react";
import type { PgnGameText } from "@chessarena/shared";
import { decodePgn, pgnChunks, pgnPlayers, splitPgnGames, type PgnPlayer } from "../lib/pgnFile";

const MAX_FILE = 60 * 1024 * 1024;

/**
 * Import d'un fichier PGN (parties de club ou de tournoi, export ChessBase, autre site) : on choisit son nom
 * parmi les joueurs du fichier, et ses parties rejoignent le répertoire, l'analyse de style et les parties commentées.
 * Seuls les coups et les en-têtes sont envoyés : jamais les commentaires ni les variantes du fichier.
 */
export function ImportPgn({ onImported, count }: { onImported: () => void; count: number }) {
  const [file, setFile] = useState<{ name: string; games: PgnGameText[]; players: PgnPlayer[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [state, setState] = useState<{ kind: "idle" | "reading" | "sending" | "done" | "error"; text?: string; done?: number; total?: number }>({ kind: "idle" });

  const read = async (f: File) => {
    if (f.size > MAX_FILE) { setState({ kind: "error", text: "Fichier trop gros (60 Mo au plus) : exporte seulement tes parties depuis ChessBase." }); return; }
    setState({ kind: "reading" });
    try {
      const games = splitPgnGames(decodePgn(await f.arrayBuffer()));
      const players = pgnPlayers(games);
      if (!games.length || !players.length) { setState({ kind: "error", text: "Aucune partie lisible dans ce fichier (est-ce bien un PGN ?)." }); return; }
      setFile({ name: f.name, games, players });
      // le joueur le plus présent est presque toujours le propriétaire de la base
      setPicked(players[0]!.games >= Math.max(2, games.length * 0.3) ? new Set([players[0]!.key]) : new Set());
      setState({ kind: "idle" });
    } catch { setState({ kind: "error", text: "Impossible de lire ce fichier." }); }
  };

  const send = async () => {
    if (!file || !picked.size) return;
    const names = file.players.filter((p) => picked.has(p.key)).map((p) => p.name);
    const { chunks, games } = pgnChunks(file.games, picked);
    if (!games) { setState({ kind: "error", text: "Aucune partie de ce joueur n'a de coups lisibles." }); return; }
    setState({ kind: "sending", done: 0, total: chunks.length });
    let added = 0, found = 0;
    for (let i = 0; i < chunks.length; i++) {
      const r = await fetch("/api/imports/pgn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pgn: chunks[i], players: names }) }).catch(() => null);
      if (!r?.ok) { setState({ kind: "error", text: `L'envoi s'est arrêté (${added} parties ajoutées). Réessaie : les parties déjà ajoutées ne seront pas doublées.` }); if (added) onImported(); return; }
      const d = (await r.json()) as { found: number; added: number };
      added += d.added; found += d.found;
      setState({ kind: "sending", done: i + 1, total: chunks.length });
    }
    setState({ kind: "done", text: `${found} partie${found > 1 ? "s" : ""} lue${found > 1 ? "s" : ""}, ${added} nouvelle${added > 1 ? "s" : ""} ajoutée${added > 1 ? "s" : ""}${found > added ? ` (${found - added} déjà présentes)` : ""}.` });
    setFile(null);
    onImported();
  };

  const remove = async () => {
    await fetch("/api/imports?source=pgn", { method: "DELETE" }).catch(() => null);
    onImported();
  };

  const busy = state.kind === "reading" || state.kind === "sending";
  return (
    <section className="panel flex flex-col gap-3 p-3" aria-label="Importer un fichier PGN">
      <div>
        <h2 className="font-display text-base font-semibold">Importer un fichier PGN</h2>
        <p className="text-xs text-muted">
          {count ? `${count} partie${count > 1 ? "s" : ""} importée${count > 1 ? "s" : ""} depuis des fichiers PGN · ` : ""}
          Tes parties de club et de tournoi, ou ta base ChessBase (Fichier → Exporter → PGN). Seuls les coups sont gardés.
        </p>
      </div>
      <label className={`inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-neon/50 px-3 py-1.5 text-sm font-semibold text-neon hover:bg-neon/10 ${busy ? "pointer-events-none opacity-50" : ""}`}>
        Choisir un fichier .pgn
        <input type="file" accept=".pgn,application/x-chess-pgn,text/plain" className="sr-only" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void read(f); }} />
      </label>
      {state.kind === "reading" && <p role="status" className="text-xs text-muted">Lecture du fichier…</p>}
      {file && (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-2.5">
          <p className="text-sm"><span className="font-semibold">{file.name}</span> · {file.games.length} partie{file.games.length > 1 ? "s" : ""}. Qui es-tu dans ce fichier ?</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ton nom dans le fichier">
            {file.players.map((p) => (
              <label key={p.key} className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${picked.has(p.key) ? "border-neon bg-neon/15 text-text" : "border-line text-muted hover:text-text"}`}>
                <input type="checkbox" className="sr-only" checked={picked.has(p.key)}
                  onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} />
                {p.name} <span className="tabular text-muted">({p.games})</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-muted">Coche plusieurs noms si tu apparais sous plusieurs écritures (« Dupont, J » et « Jean Dupont »).</p>
          <div className="flex gap-2">
            <button type="button" disabled={!picked.size || busy} onClick={() => void send()} className="neon-btn rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-40">
              Ajouter mes parties
            </button>
            <button type="button" onClick={() => setFile(null)} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-text">Annuler</button>
          </div>
        </div>
      )}
      {state.kind === "sending" && (
        <div role="status" className="text-xs text-muted">
          Envoi… {state.done} / {state.total}
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-surface-2"><div className="h-full bg-neon transition-all" style={{ width: `${state.total ? (100 * (state.done ?? 0)) / state.total : 0}%` }} /></div>
        </div>
      )}
      {state.kind === "done" && <p role="status" className="text-sm text-win">{state.text}</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-danger">{state.text}</p>}
      {!!count && !busy && <button type="button" onClick={() => void remove()} className="self-start text-xs text-muted underline hover:text-danger">Supprimer les parties importées depuis des fichiers PGN</button>}
    </section>
  );
}
