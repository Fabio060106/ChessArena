"use client";
import { useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { Color } from "@chessarena/shared";
import { PageHeader } from "../../../components/PageHeader";
import { FlipButton } from "../../../components/SiteNav";
import { GameBoard } from "../../../components/GameBoard";
import { PlayerCard } from "../../../components/PlayerCard";
import { ChessClock } from "../../../components/ChessClock";
import { MoveList } from "../../../components/MoveList";
import { MoveNav, usePlyKeys } from "../../../components/MoveNav";
import { ChatPanel } from "../../../components/ChatPanel";
import { useGameAuth, useMe } from "../../../hooks/useMe";
import { useWatch } from "../../../hooks/useWatch";
import { useClockTicker } from "../../../hooks/useGameSocket";
import { useFlip } from "../../../hooks/useFlip";
import { useSettings } from "../../../lib/settings";
import { material } from "../../../lib/material";
import { materialAdvantage } from "../../../lib/profile";
import { replayFromSans } from "../../../lib/replay";
import { START_FEN } from "../../../lib/gameReducer";
import { TC_LABEL } from "../../../lib/social";

const END: Record<string, string> = {
  checkmate: "échec et mat", resignation: "abandon", timeout: "temps écoulé", abandon: "forfait (déconnexion)",
  stalemate: "pat", repetition: "triple répétition", insufficient_material: "matériel insuffisant",
  fifty_moves: "règle des 50 coups", aborted: "partie annulée", timeout_vs_insufficient_material: "temps écoulé, matériel insuffisant",
  agreement: "nulle par accord mutuel",
};

/** Regarder une partie en direct. */
export default function WatchPage() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const valid = typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);
  return (
    <main className="arena-app">
      <PageHeader title="Partie en direct" active="/direct" />
      {!valid ? <p className="mx-auto max-w-[700px] p-4 text-sm text-danger">Lien de partie invalide.</p>
        : me ? <Watch gameId={id} me={me.userId} /> : <p className="p-4 text-sm text-muted">Chargement…</p>}
    </main>
  );
}

function Watch({ gameId, me }: { gameId: string; me: string }) {
  const getAuth = useGameAuth();
  const { view, sync, sendChat } = useWatch(gameId, getAuth);
  const [settings] = useSettings();
  const [flipped, flip] = useFlip();
  const [tab, setTab] = useState<"moves" | "players" | "spectators">("moves");
  const live = view.status === "watching";
  const subscribe = useClockTicker(view.state, sync, !live);

  // navigation dans les coups (null = direct)
  const [browse, setBrowse] = useState<number | null>(null);
  const steps = useMemo(() => replayFromSans(view.moves), [view.moves]);
  const last = steps.length - 1;
  const browsing = browse !== null && browse < last;
  const navPly = browsing ? browse : last;
  const go = useCallback((p: number) => { const c = Math.max(0, Math.min(last, p)); setBrowse(c >= last ? null : c); }, [last]);
  usePlyKeys(navPly, last, go, steps.length > 1);

  if (view.status === "missing" && !view.over) {
    return (
      <div className="mx-auto max-w-[700px] p-3">
        <p className="panel p-4 text-sm text-muted">Cette partie n'est plus en cours (ou n'existe pas). <a href="/direct" className="text-neon underline">Voir les parties en direct</a>.</p>
      </div>
    );
  }
  if (!view.start) return <p className="mx-auto max-w-[700px] p-4 text-sm text-muted">Connexion à la partie… (le serveur peut mettre une minute à se réveiller)</p>;

  const start = view.start;
  const fen = browsing ? steps[browse]!.fen : view.fen ?? START_FEN;
  const lastMove = browsing ? steps[browse]!.uci : view.lastMove;
  const bottom: Color = flipped ? "b" : "w";
  const top: Color = bottom === "w" ? "b" : "w";
  const mat = material(fen);
  const running = live && view.state && view.state.ply >= 2 ? view.state.turn : null;
  const seat = (c: Color) => (c === "w" ? start.white : start.black);
  const card = (c: Color) => (
    <PlayerCard userId={seat(c).userId} rating={seat(c).rating} flag={seat(c).flag}
      pingMs={view.net ? view.net.rttMs[c] : undefined} toMove={running === c}
      graceMs={view.away && view.away.userId === seat(c).userId ? view.away.graceMs : null}
      materialAdvantage={materialAdvantage(fen, c)} captured={mat[c].captured}
      clock={<ChessClock color={c} subscribe={subscribe} active={running === c} initialMs={start.timeControl.initialMs} alert={false} />} />
  );
  const playersChat = view.chat.filter((m) => m.channel === "players");
  const specChat = view.chat.filter((m) => m.channel === "spectators");
  const resultText = view.over
    ? view.over.termination === "aborted" ? "Partie annulée"
      : view.over.result === "1/2-1/2" ? "Nulle"
      : `Victoire de ${view.over.result === "1-0" ? start.white.userId : start.black.userId}`
    : null;

  return (
    <div className="mx-auto grid max-w-[1400px] gap-4 px-2 pb-6 sm:px-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:px-6">
      <section className="mx-auto flex w-full flex-col gap-1.5" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 230px)))" }}>
        {card(top)}
        <div className="relative">
          <GameBoard fen={fen} serverFen={fen} orientation={bottom} myColor={bottom} interactive={false} myTurn={false}
            lastMove={lastMove} premoves={[]} theme={settings.boardTheme} coordinates={settings.coordinates}
            onMove={() => false} onCancelPremoves={() => {}} />
          {browsing && (
            <button type="button" onClick={() => setBrowse(null)}
              className="absolute left-1/2 top-2 z-[45] -translate-x-1/2 rounded-full border border-gold/60 bg-ink/85 px-3 py-1 text-xs font-semibold text-gold shadow-lg backdrop-blur">
              {live ? "revenir au direct ⏭" : "dernière position ⏭"}
            </button>
          )}
        </div>
        {card(bottom)}
        <p className="px-2 text-center text-xs text-muted" role="status">
          {resultText ? <span className="font-semibold text-text">{resultText} · {view.over!.result} ({END[view.over!.termination] ?? view.over!.termination})</span>
            : <><span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle" /> En direct · {TC_LABEL[start.timeControl.id]}</>}
          <span className="ml-2 whitespace-nowrap">👁 {view.spectators} spectateur{view.spectators > 1 ? "s" : ""}</span>
          {!view.connected && <span className="ml-2 text-gold">reconnexion…</span>}
        </p>
        {view.drawOffer && live && <p className="px-2 text-center text-xs text-gold">{seat(view.drawOffer).userId} propose la nulle.</p>}
      </section>

      <aside className="flex w-full flex-col gap-3">
        <div className="panel flex flex-wrap items-center gap-2 p-3">
          <p className="min-w-0 flex-1 text-sm">
            <a className="font-semibold hover:underline" href={`/profil/${encodeURIComponent(start.white.userId)}`}>{start.white.userId}</a>
            <span className="text-muted"> vs </span>
            <a className="font-semibold hover:underline" href={`/profil/${encodeURIComponent(start.black.userId)}`}>{start.black.userId}</a>
            {view.tournamentId && <a href={`/play?t=${view.tournamentId}`} className="ml-2 text-xs text-neon hover:underline">tournoi →</a>}
          </p>
          <FlipButton onFlip={flip} />
        </div>
        <div className="panel p-3">
          <div className="mb-3 flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist">
            {([["moves", "Coups"], ["players", "Chat des joueurs"], ["spectators", "Spectateurs"]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold sm:text-sm ${tab === k ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === "moves" ? (
            <div className="flex flex-col gap-2">
              {last > 0 && <MoveNav compact ply={navPly} last={last} go={go} />}
              <MoveList moves={view.moves} active={navPly - 1} onSelect={(p) => go(p + 1)} />
            </div>
          ) : tab === "players" ? (
            <ChatPanel messages={playersChat} me={me} empty="Les joueurs n'ont rien écrit pour l'instant." />
          ) : (
            <ChatPanel messages={specChat} me={me} onSend={view.over ? undefined : sendChat}
              placeholder="Commenter avec les autres spectateurs…" quick={["Joli coup !", "Quelle partie", "😮"]}
              empty="Les joueurs ne voient pas ce chat : pas de conseils possibles pendant la partie." />
          )}
        </div>
      </aside>
    </div>
  );
}
