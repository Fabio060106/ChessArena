"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { useRouter } from "next/navigation";
import type { GameHistoryDetail, GameHistoryItem, TimeControlId } from "@chessarena/shared";
import { GameBoard } from "../../components/GameBoard";
import { MoveList } from "../../components/MoveList";
import { PlayerCard } from "../../components/PlayerCard";
import { useSettings } from "../../lib/settings";
import { material } from "../../lib/material";
import { materialAdvantage } from "../../lib/profile";
import { formatThink, relativeDate, replayFromPgn } from "../../lib/replay";
import { MoveNav, usePlyKeys } from "../../components/MoveNav";
import { PageHeader } from "../../components/PageHeader";
import { GameReplay, OUTCOME, TC, TERM } from "../../components/GameReplay";
import { FlipButton } from "../../components/SiteNav";
import { useFlip } from "../../hooks/useFlip";
import { fetchWake, localCache } from "../../lib/wake";
import { applyMove, atMain, currentStep, numbered, playOnBoard, previousStep, type Cursor } from "../../lib/variation";
import { moveSound, sound } from "../../lib/sound";
import { accuracy, classify, Engine, ENGINE_NAME, formatScore, pvToSan, scoreToCp, terminalScore, winPct, type EngineLine, type MoveMark, type Score } from "../../lib/engine";

/** Historique des parties du joueur connecté, avec relecture coup par coup. */
export default function HistoryPage() {
  const router = useRouter();
  const [me, setMe] = useState<string | null>(null);
  const [games, setGames] = useState<GameHistoryItem[] | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMe(((await r.json()) as { userId: string }).userId) : router.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)))
      .catch(() => router.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`));
  }, [router]);

  const [waking, setWaking] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  // copie locale : affichée tout de suite, remplacée dès que le serveur répond
  useEffect(() => {
    if (!me) return;
    const cached = localCache.get<GameHistoryItem[]>(`history.${me}`);
    if (cached?.length) {
      setGames((g) => g ?? cached);
      setFromCache(true);
      const wanted = new URLSearchParams(window.location.search).get("g");
      setSelected((sel) => sel ?? (wanted && /^[0-9a-f-]{36}$/i.test(wanted) ? wanted : cached[0]!.gameId));
    }
  }, [me]);
  const load = useCallback(async (before?: string) => {
    setError(null);
    const r = await fetchWake(`/api/history${before ? `?before=${encodeURIComponent(before)}` : ""}`, { onWaiting: setWaking });
    if (!r?.ok) {
      setError(r?.status === 503 ? "L'historique nécessite la base de données du serveur." : "Le serveur ne répond pas pour le moment. Réessaie dans quelques minutes.");
      setGames((g) => g ?? []);
      return;
    }
    const page = ((await r.json()) as { games: GameHistoryItem[] }).games;
    setFromCache(false);
    setGames((g) => {
      const next = [...(before ? g ?? [] : []), ...page];
      if (me) localCache.set(`history.${me}`, next.slice(0, 500));
      return next;
    });
    setMore(page.length === 30);
    const wanted = new URLSearchParams(window.location.search).get("g");
    if (!before && wanted && /^[0-9a-f-]{36}$/i.test(wanted)) setSelected((s) => s ?? wanted);
    else if (!before && page[0]) setSelected((s) => s ?? page[0]!.gameId);
  }, [me]);
  useEffect(() => { if (me) void load(); }, [me, load]);

  // bilan sur TOUTES les parties (pas seulement celles déjà chargées)
  const [totals, setTotals] = useState<{ games: number; wins: number; draws: number; losses: number } | null>(null);
  useEffect(() => {
    if (!me) return;
    fetch(`/api/players/${encodeURIComponent(me)}`, { cache: "no-store" })
      .then(async (r) => { if (r.ok) setTotals(((await r.json()) as { totals: { games: number; wins: number; draws: number; losses: number } }).totals); })
      .catch(() => {});
  }, [me, games?.length]);
  const stats = useMemo(() => {
    if (totals) return { n: totals.games, w: totals.wins, d: totals.draws, l: totals.losses };
    const played = (games ?? []).filter((g) => g.outcome !== "aborted");
    return { n: played.length, w: played.filter((g) => g.outcome === "win").length, d: played.filter((g) => g.outcome === "draw").length, l: played.filter((g) => g.outcome === "loss").length };
  }, [games, totals]);

  return (
    <main className="arena-app">
      <PageHeader title="Mes parties" active="/history">
        <a href="/play" className="neon-btn rounded-lg px-3 py-1.5 text-sm font-semibold">Jouer</a>
      </PageHeader>

      <div className="mx-auto grid max-w-[1400px] gap-4 px-2 pb-8 sm:px-3 lg:grid-cols-[380px_minmax(0,1fr)] lg:px-6">
        <section className="flex flex-col gap-3">
          {stats.n > 0 && (
            <div className="panel grid grid-cols-4 gap-2 p-3 text-center">
              <Stat label="Parties" value={stats.n} />
              <Stat label="Victoires" value={stats.w} cls="text-win" />
              <Stat label="Nulles" value={stats.d} />
              <Stat label="Défaites" value={stats.l} cls="text-danger" />
            </div>
          )}
          {stats.n > 0 && (
            <p className="flex items-center justify-between gap-2 px-1 text-xs text-muted">
              <span>Toutes tes parties sont conservées.</span>
              <a href="/api/history/export" className="font-semibold text-neon hover:underline">⬇ Télécharger tout (PGN)</a>
            </p>
          )}
          {waking && <p role="status" className="rounded-lg border border-gold/30 bg-gold/10 p-2.5 text-sm text-gold">Le serveur se réveille (jusqu'à une minute)… tes parties arrivent.</p>}
          {fromCache && !waking && <p className="px-1 text-xs text-muted">Copie enregistrée sur cet appareil — mise à jour en cours…</p>}
          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-sm text-danger">{error}</p>}
          {games === null && <p className="px-1 text-sm text-muted">Chargement…</p>}
          {games?.length === 0 && !error && (
            <div className="panel p-4 text-sm text-muted">Aucune partie pour l'instant. <a href="/play" className="text-neon underline">Joue ta première partie</a>.</div>
          )}
          <ul className="flex flex-col gap-1.5">
            {games?.map((g) => (
              <li key={g.gameId}>
                <button type="button" onClick={() => setSelected(g.gameId)}
                  className={`panel flex w-full items-center gap-3 p-3 text-left transition ${selected === g.gameId ? "border-neon/60 ring-1 ring-neon/30" : "hover:border-line"}`}>
                  <span className={`w-20 shrink-0 rounded-md px-2 py-1 text-center text-xs font-semibold ${OUTCOME[g.outcome].cls}`}>{OUTCOME[g.outcome].label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block size-2.5 rounded-sm border border-line ${g.color === "w" ? "bg-[#E7ECF3]" : "bg-[#1C2233]"}`} aria-label={g.color === "w" ? "Blancs" : "Noirs"} />
                      <span className="truncate font-semibold">{g.opponent}</span>
                      {g.opponentRating !== null && <span className="tabular text-xs text-muted">{g.opponentRating}</span>}
                    </span>
                    <span className="block text-xs text-muted">{TC[g.timeControl]} · {TERM[g.termination] ?? g.termination} · {Math.ceil(g.plies / 2)} coups{g.tournamentId ? " · tournoi" : ""}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    {g.ratingBefore !== null && g.ratingAfter !== null && (
                      <span className={`tabular block font-semibold ${g.ratingAfter >= g.ratingBefore ? "text-win" : "text-danger"}`}>
                        {g.ratingAfter >= g.ratingBefore ? "+" : ""}{g.ratingAfter - g.ratingBefore}
                      </span>
                    )}
                    <span className="text-muted">{relativeDate(g.endedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {games && games.length > 0 && more && (
            <button type="button" onClick={() => void load(games[games.length - 1]!.endedAt)} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">
              Parties plus anciennes
            </button>
          )}
        </section>

        <section>{selected && me ? <GameReplay key={selected} gameId={selected} me={me} /> : null}</section>
      </div>
    </main>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: number; cls?: string }) {
  return (
    <div>
      <p className={`tabular font-display text-xl font-bold ${cls}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}

/** Profondeurs : passe rapide sur toute la partie, puis analyse plus poussée de la position affichée. */
