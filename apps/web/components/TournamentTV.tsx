"use client";
import { useMemo } from "react";
import type { SngSnapshot } from "@chessarena/shared";
import { GameBoard } from "./GameBoard";
import { ChessClock } from "./ChessClock";
import { useGameAuth } from "../hooks/useMe";
import { useWatch } from "../hooks/useWatch";
import { useClockTicker } from "../hooks/useGameSocket";
import { useSettings } from "../lib/settings";
import { START_FEN } from "../lib/gameReducer";

/**
 * « TV du tournoi » : la partie de tête en direct sur la page du tournoi (à projeter au club).
 * Partie choisie : celle dont les deux joueurs ont le plus de points (puis le plus d'Elo), hors parties du spectateur ;
 * quand elle se termine, la TV passe toute seule à la suivante.
 */
export function TournamentTV({ t, userId }: { t: SngSnapshot; userId: string }) {
  const gameId = useMemo(() => featuredGame(t, userId), [t, userId]);
  if (!gameId) return null;
  return <TVBoard key={gameId} gameId={gameId} />;
}

export function featuredGame(t: SngSnapshot, userId: string): string | null {
  if (t.status !== "running") return null;
  const pts = new Map(t.players.map((p) => [p.userId, p.points ?? 0]));
  const elo = new Map(t.players.map((p) => [p.userId, p.rating]));
  let best: { id: string; key: number } | null = null;
  for (const m of t.rounds.flat()) {
    if (m.status !== "playing" || !m.p1 || !m.p2 || m.p1 === userId || m.p2 === userId) continue;
    const g = m.games.at(-1);
    if (!g || g.result) continue;
    const key = ((pts.get(m.p1) ?? 0) + (pts.get(m.p2) ?? 0)) * 10_000 + (elo.get(m.p1) ?? 0) + (elo.get(m.p2) ?? 0);
    if (!best || key > best.key) best = { id: g.gameId, key };
  }
  return best?.id ?? null;
}

function TVBoard({ gameId }: { gameId: string }) {
  const getAuth = useGameAuth();
  const { view, sync } = useWatch(gameId, getAuth, { quiet: true });
  const [settings] = useSettings();
  const live = view.status === "watching";
  const subscribe = useClockTicker(view.state, sync, !live);
  const start = view.start;
  if (!start) return null;
  const running = live && view.state && view.state.ply >= 2 ? view.state.turn : null;
  const row = (c: "w" | "b") => {
    const p = c === "w" ? start.white : start.black;
    return (
      <div className="flex items-center gap-2 px-1 text-sm">
        <span className={`size-3 shrink-0 rounded-sm border border-line ${c === "w" ? "bg-[#f3f3f3]" : "bg-[#222]"}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold">{p.userId}<span className="tabular ml-1.5 text-xs font-normal text-muted">{p.rating}</span></span>
        <div className="w-24 shrink-0"><ChessClock color={c} subscribe={subscribe} active={running === c} initialMs={start.timeControl.initialMs} alert={false} /></div>
      </div>
    );
  };
  const over = view.over ? (view.over.result === "1/2-1/2" ? "Nulle" : `Victoire de ${view.over.result === "1-0" ? start.white.userId : start.black.userId}`) : null;
  return (
    <section aria-label="TV du tournoi" className="panel flex flex-col gap-1.5 border-neon/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[.14em] text-neon"><span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle" />TV du tournoi · partie de tête</h3>
        <a href={`/direct/${gameId}`} className="text-xs text-neon hover:underline">En grand →</a>
      </div>
      {row("b")}
      <div className="mx-auto w-full max-w-[min(100%,52dvh)]">
        <GameBoard fen={view.fen ?? START_FEN} serverFen={view.fen ?? START_FEN} orientation="w" myColor="w" interactive={false} myTurn={false}
          lastMove={view.lastMove} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
          onMove={() => false} onCancelPremoves={() => {}} />
      </div>
      {row("w")}
      {over && <p className="text-center text-xs font-semibold text-gold">{over} · la TV passe à la partie suivante</p>}
    </section>
  );
}
