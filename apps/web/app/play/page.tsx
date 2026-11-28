"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Color } from "@chessarena/shared";
import { overText, tournamentIntro } from "../../lib/overText";
import { useClockTicker, useGameSocket } from "../../hooks/useGameSocket";
import { useTournament } from "../../hooks/useTournament";
import { useTournamentChat } from "../../hooks/useTournamentChat";
import { errorMessage, isMyTurn, sessionBanner, START_FEN } from "../../lib/gameReducer";
import { useSettings } from "../../lib/settings";
import { materialAdvantage } from "../../lib/profile";
import { material } from "../../lib/material";
import { formatMoney } from "../../lib/tournament";
import { sound } from "../../lib/sound";
import { GameBoard } from "../../components/GameBoard";
import { ChessClock } from "../../components/ChessClock";
import { PlayerCard } from "../../components/PlayerCard";
import { TournamentHUD } from "../../components/TournamentHUD";
import { MoveList } from "../../components/MoveList";
import { MoveNav, usePlyKeys } from "../../components/MoveNav";
import { replayFromSans } from "../../lib/replay";
import { OfficialBanner } from "../../components/OfficialBanner";
import { RelayBanner } from "../../components/RelayBanner";
import { Lobby } from "../../components/Lobby";
import { Logo } from "../../components/Logo";
import { ChatPanel } from "../../components/ChatPanel";
import { CheatReport } from "../../components/CheatReport";
import { FlipButton, SiteNav } from "../../components/SiteNav";
import { useFlip } from "../../hooks/useFlip";

const RESULT_LABEL: Record<string, string> = {
  checkmate: "échec et mat", resignation: "abandon", timeout: "temps écoulé", abandon: "forfait (déconnexion)",
  stalemate: "pat", repetition: "triple répétition", insufficient_material: "matériel insuffisant",
  fifty_moves: "règle des 50 coups", aborted: "partie annulée", timeout_vs_insufficient_material: "temps écoulé, matériel insuffisant",
  agreement: "nulle par accord mutuel",
};

export default function PlayPage() {
  return (
    <Suspense>
      <Play />
    </Suspense>
  );
}

/**
 * Identité du joueur : session bêta (cookie, /api/session) ; en développement uniquement,
 * `?u=alice&flag=FR` reste possible (jeton signé par /api/dev-token).
 */
function Play() {
  const params = useSearchParams();
  const router = useRouter();
  const devUser = process.env.NODE_ENV !== "production" ? params.get("u") : null;
  const [me, setMe] = useState<{ userId: string; flag?: string } | null>(
    devUser ? { userId: devUser, flag: params.get("flag") ?? undefined } : null,
  );
  useEffect(() => {
    if (devUser) return;
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMe((await r.json()) as { userId: string; flag?: string }) : router.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)))
      .catch(() => router.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`));
  }, [devUser, router]);
  if (!me) return <main className="arena-app grid place-items-center text-sm text-muted">Chargement…</main>;
  const invite = params.get("t");
  return <Arena userId={me.userId} flag={me.flag ?? ""} dev={!!devUser} inviteId={invite && /^[0-9a-f-]{36}$/i.test(invite) ? invite : null} wantTournament={params.get("onglet") === "tournoi"} />;
}

const REMATCH_ERRORS: Record<string, string> = {
  IN_GAME: "Ton adversaire (ou toi) est déjà dans une autre partie.",
  IN_TOURNAMENT: "Pas de revanche pendant un tournoi.",
  EXPIRED: "Trop tard : la revanche n'est possible que 5 minutes après la partie.",
  NO_GAME: "La revanche n'est plus possible pour cette partie.",
  STAKE_LOCK_FAILED: "Solde insuffisant pour rejouer avec la même mise.",
  PLAY_MONEY_ONLY: "Revanche possible uniquement en jetons PLAY.",
};

const TC_NAME = { bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0" } as const;

function Arena({ userId, flag, dev, inviteId, wantTournament = false }: { userId: string; flag: string; dev: boolean; inviteId: string | null; wantTournament?: boolean }) {
  const getAuth = useCallback(async () => {
    const url = dev ? `/api/dev-token?${new URLSearchParams({ u: userId, ...(flag ? { flag } : {}) })}` : "/api/token";
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? { token: ((await r.json()) as { token: string }).token } : {};
  }, [userId, flag, dev]);

  const { view, socket, sync, localRtt, joinQueue, leaveQueue, playOrPremove, cancelPremoves, resign, draw, chat, sendChat, reportChat, reportCheat, rematch, rematchAction, spectators, queueStats } = useGameSocket(userId, getAuth);
  const sng = useTournament(socket, userId, inviteId);
  const tchat = useTournamentChat(socket, sng.current?.id ?? null);
  const [settings, updateSettings] = useSettings();
  const playing = view.phase === "playing";
  const subscribe = useClockTicker(view.server, sync, !playing);
  const graceLeft = useCountdown(view.opponentPresence?.graceMs ?? null, view.opponentPresence);
  const [confirmResign, setConfirmResign] = useState(false);
  const [tab, setTab] = useState<"tournament" | "moves" | "chat">(inviteId || wantTournament ? "tournament" : "moves");
  const [showResult, setShowResult] = useState(true);
  // navigation dans les coups (comme Lichess) : null = position en direct
  const [browse, setBrowse] = useState<number | null>(null);
  const steps = useMemo(() => replayFromSans(view.moves), [view.moves]);
  const liveLast = steps.length - 1;
  const browsing = browse !== null && browse < liveLast;
  const navPly = browsing ? browse : liveLast;
  const go = useCallback((p: number) => {
    const c = Math.max(0, Math.min(liveLast, p));
    setBrowse(c >= liveLast ? null : c);
  }, [liveLast]);
  usePlyKeys(navPly, liveLast, go, !!view.start);
  useEffect(() => { setConfirmResign(false); setShowResult(true); }, [view.phase]);
  // nouvelle partie (tournoi qui démarre pendant qu'on lit le classement, sur mobile) : on remonte au plateau
  const gameId = view.start?.gameId;
  // Défilement INSTANTANÉ (et seulement si le plateau n'est pas entièrement visible) : un défilement animé
  // déplaçait l'échiquier sous le doigt pendant le premier coup.
  const boardBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setBrowse(null);
    const r = boardBox.current?.getBoundingClientRect();
    if (gameId && r && (r.top < 0 || r.bottom > window.innerHeight)) window.scrollTo({ top: 0, behavior: "instant" });
  }, [gameId]);
  useEffect(() => { if (sng.current && !playing) setTab("tournament"); }, [sng.current, playing]);
  const [flipped, flip] = useFlip(gameId);
  // messages non lus (onglet Chat fermé)
  const [readCount, setReadCount] = useState(0);
  const othersMsgs = chat.filter((m) => m.userId !== userId).length;
  useEffect(() => { if (tab === "chat") setReadCount(othersMsgs); }, [tab, othersMsgs]);
  useEffect(() => { setReadCount(0); }, [gameId]);
  const unread = tab === "chat" ? 0 : Math.max(0, othersMsgs - readCount);
  const [rematchErr, setRematchErr] = useState<string | null>(null);
  useEffect(() => { setRematchErr(null); }, [gameId]);
  // pas de revanche en tournoi (le tableau décide du prochain adversaire) ; revanche possible 2 min, tant que l'adversaire est là
  const tournamentGame = !!view.start?.tournament;
  const [rematchExpired, setRematchExpired] = useState(false);
  useEffect(() => {
    setRematchExpired(false);
    if (view.phase !== "over") return;
    const t = setTimeout(() => setRematchExpired(true), 120_000);
    return () => clearTimeout(t);
  }, [view.phase, gameId]);
  const rematchOver = view.phase === "over" && !!view.start && !tournamentGame && (rematchExpired || !!rematch?.unavailable);
  const canRematch = view.phase === "over" && !!view.start && !tournamentGame && sng.current?.status !== "running" && !rematchOver;
  const doRematch = async (action: "offer" | "decline") => {
    setRematchErr(null);
    const r = await rematchAction(action);
    if (!r.ok) setRematchErr(REMATCH_ERRORS[r.code] ?? "La revanche n'est plus possible.");
  };
  // signalement de triche : après une vraie partie (pas une partie annulée)
  const canReportCheat = view.phase === "over" && !!view.start && !!view.over && view.over.termination !== "aborted";
  const rematchByOpp = !!rematch?.offeredBy && rematch.offeredBy !== userId;
  const rematchByMe = rematch?.offeredBy === userId;

  // le contexte audio ne peut démarrer que sur un geste : premier clic n'importe où
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, []);

  const me: Color = view.myColor;
  const opp: Color = me === "w" ? "b" : "w";
  const bottom: Color = flipped ? opp : me;
  const top: Color = flipped ? me : opp;
  const seat = (c: Color) => (c === "w" ? view.start?.white : view.start?.black);
  const running = playing && view.server && view.server.ply >= 2 ? view.server.turn : null;
  const fen = browsing ? steps[browse]!.fen : view.start ? view.displayFen : START_FEN;
  const initialMs = view.start?.timeControl.initialMs ?? 0;
  const myTurn = isMyTurn(view) && view.premoves.length === 0;
  const mat = useMemo(() => material(fen), [fen]);
  const inTournament = !!sng.current && (sng.current.status === "running" || sng.current.players.some((p) => p.userId === userId && p.status === "registered"));
  const lobbyFirst = (view.phase === "idle" || view.phase === "queued" || view.phase === "connecting") && !inTournament;
  const lobby = (
    <Lobby
      queued={view.queue?.timeControl ?? null}
      queuedStake={view.queue?.stake.buyInCents ?? null}
      defaultStake={view.queue?.stake.buyInCents ?? (view.start && !view.start.tournament ? view.start.stake.buyInCents : undefined)}
      stats={queueStats}
      disabled={!view.connected}
      onJoin={(timeControl, buyInCents) => joinQueue({ timeControl, stake: { currency: "PLAY", buyInCents } })}
      onLeave={leaveQueue}
    />
  );
  const pingOf = (c: Color) => view.net?.rttMs[c] ?? (c === me ? localRtt : null);

  const iWon = useMemo(() => {
    if (!view.over || view.over.result === "1/2-1/2") return null;
    return (view.over.result === "1-0") === (me === "w");
  }, [view.over, me]);

  const card = (c: Color) => c === opp ? (
    <PlayerCard
      userId={seat(opp)?.userId ?? "Adversaire"} rating={seat(opp)?.rating} flag={seat(opp)?.flag} profileLink={!!seat(opp)}
      pingMs={view.start ? pingOf(opp) : null} toMove={running === opp} graceMs={graceLeft}
      materialAdvantage={view.start ? materialAdvantage(fen, opp) : 0} captured={view.start ? mat[opp].captured : undefined}
      clock={<ChessClock color={opp} subscribe={subscribe} active={running === opp} initialMs={initialMs} alert={false} />}
    />
  ) : (
    <PlayerCard
      userId={view.start ? (seat(me)?.userId ?? userId) : userId} rating={seat(me)?.rating} flag={seat(me)?.flag ?? (flag || undefined)}
      pingMs={pingOf(me)} isMe toMove={running === me}
      materialAdvantage={view.start ? materialAdvantage(fen, me) : 0} captured={view.start ? mat[me].captured : undefined}
      clock={<ChessClock color={me} subscribe={subscribe} active={running === me} initialMs={initialMs} alert={settings.timeAlert} />}
    />
  );

  const plyLabel = (p: number) => (p === 0 ? "position de départ" : `${Math.ceil(p / 2)}${p % 2 === 1 ? "." : "…"} ${steps[p]?.san ?? ""}`);
  const status = !playing ? null
    : browsing ? `Vous regardez ${plyLabel(browse!)} — la partie continue. ⏭, → ou un clic sur l'échiquier pour revenir.`
    : view.server && view.server.ply < 2 ? `${tournamentIntro(view.start?.tournament?.kind, view.start?.tournament?.round, !!view.start?.tournament?.swiss, !!view.start?.tournament?.arena)}Jouez votre premier coup dans les ${Math.round((view.start?.firstMoveMs ?? 20_000) / 1000)} s, sinon ${tournamentGame ? (view.start?.tournament?.arena ? "0 point et votre série s'arrête" : view.start?.tournament?.swiss ? "vous perdez cette partie du tournoi" : "vous perdez ce match du tournoi") : "la partie est annulée"}.`
    : isMyTurn(view) ? "À vous de jouer."
    : view.premoves.length ? `${view.premoves.length} pré-move${view.premoves.length > 1 ? "s" : ""} en file · clic droit ou Échap pour annuler`
    : "L'adversaire réfléchit…";

  return (
    <main className="arena-app">
      <header className="mx-auto flex h-13 max-w-[1400px] items-center gap-3 px-3 lg:px-6">
        <h1 className="font-display text-lg font-bold tracking-tight">
          <Logo />
        </h1>
        <span className={`flex items-center gap-1.5 text-xs ${view.connected ? "text-win" : "text-gold"}`}>
          <span className={`size-1.5 rounded-full ${view.connected ? "bg-win" : "animate-pulse bg-gold"}`} />
          {view.connected ? "connecté" : "reconnexion…"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <FlipButton onFlip={flip} className="!px-2 !py-1 text-xs" />
          {!dev && (
            <button type="button" title="Se déconnecter"
              onClick={() => void fetch("/api/session", { method: "DELETE" }).finally(() => { window.location.href = "/"; })}
              className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">
              Quitter
            </button>
          )}
          <button type="button" onClick={() => updateSettings({ soundOn: !settings.soundOn })} aria-pressed={settings.soundOn}
            title={settings.soundOn ? "Couper le son" : "Activer le son"} className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">
            {settings.soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </header>
      <SiteNav active="/play" />
      {!playing && <RelayBanner className="mx-auto mb-3 max-w-[1400px] px-2 sm:px-3 lg:px-6" />}
      {!playing && !inTournament && <OfficialBanner className="mx-auto mb-3 max-w-[1400px] px-2 sm:px-3 lg:px-6" />}

      <div className="mx-auto grid max-w-[1400px] gap-4 px-2 pb-6 sm:px-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:px-6">
        {/* mobile, hors partie : le choix de cadence d'abord, l'échiquier ensuite */}
        {lobbyFirst && <div className="panel p-3 lg:hidden">{lobby}</div>}
        {/* ─── Zone de jeu : la taille du plateau suit la hauteur ET la largeur disponibles ─── */}
        <section className="mx-auto flex w-full flex-col gap-1.5" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 200px)))" }}>
          {card(top)}
          <div ref={boardBox} className="relative" onPointerDownCapture={(e) => {
            // en navigation, un clic sur le plateau ramène au direct SANS jouer : on ne joue jamais depuis une position passée
            if (browsing) { e.stopPropagation(); e.preventDefault(); setBrowse(null); }
          }}>
            <GameBoard
              fen={fen}
              serverFen={browsing ? fen : (view.server?.fen ?? fen)}
              orientation={bottom}
              myColor={me}
              interactive={playing && !browsing}
              myTurn={myTurn}
              lastMove={browsing ? steps[browse]!.uci : view.lastMove}
              premoves={browsing ? [] : view.premoves}
              theme={settings.boardTheme}
              pieceSet={settings.pieceSet}
              autoQueen={settings.autoQueen}
              palette={settings.palette}
              coordinates={settings.coordinates}
              onMove={playOrPremove}
              onCancelPremoves={cancelPremoves}
            />
            {browsing && (
              <button type="button" onClick={() => setBrowse(null)}
                className="absolute left-1/2 top-2 z-[45] -translate-x-1/2 rounded-full border border-gold/60 bg-ink/85 px-3 py-1 text-xs font-semibold text-gold shadow-lg backdrop-blur">
                {plyLabel(browse!)} · {playing ? "revenir au direct ⏭" : "dernière position ⏭"}
              </button>
            )}
            {view.phase === "over" && view.over && showResult && (
              <div className="absolute inset-0 z-50 grid place-items-center bg-ink/55 backdrop-blur-[2px]">
                <div className="panel w-[min(86%,340px)] p-5 text-center shadow-2xl">
                  {(() => {
                    const o = overText(view.over, view.start, me, iWon);
                    return (
                      <>
                        <p className={`font-display text-3xl font-bold ${o.tone === "win" ? "text-win" : o.tone === "loss" ? "text-danger" : "text-text"}`}>{o.title}</p>
                        <p className="mt-1 text-sm text-muted">{o.line ?? `${view.over.result} · ${RESULT_LABEL[view.over.termination] ?? view.over.termination}`}</p>
                        {o.note && <p className="mt-2 rounded-lg bg-surface-2 px-2.5 py-2 text-left text-xs leading-relaxed">{o.note}</p>}
                      </>
                    );
                  })()}
                  {view.over.ratingChanges?.[userId] && (() => {
                    const r = view.over!.ratingChanges![userId]!;
                    const d = r.after - r.before;
                    return <p className="tabular mt-2 text-sm">Elo {r.after} <span className={d >= 0 ? "text-win" : "text-danger"}>({d >= 0 ? "+" : ""}{d})</span></p>;
                  })()}
                  {view.start && view.start.stake.buyInCents > 0 && (
                    <p className="tabular mt-1 text-sm text-muted">
                      {view.over.payouts[userId] !== undefined && <>Crédité : <span className="text-gold">{formatMoney(view.over.payouts[userId]!, view.start.stake.currency)}</span></>}
                      {view.over.rakeCents > 0 && ` · rake ${formatMoney(view.over.rakeCents, view.start.stake.currency)}`}
                    </p>
                  )}
                  {canRematch && <RematchBox byOpp={rematchByOpp} byMe={rematchByMe} declined={!!rematch?.declined} error={rematchErr}
                    opponent={seat(opp)?.userId ?? "Ton adversaire"} onAction={doRematch} />}
                  {rematchOver && <p className="mt-3 text-xs text-muted">{rematch?.unavailable ? `${seat(opp)?.userId ?? "Ton adversaire"} n'est plus disponible : revanche impossible.` : "Délai de revanche écoulé."}</p>}
                  <div className="mt-4 flex gap-2">
                    {tournamentGame ? (
                      <button type="button" className="neon-btn flex-1 rounded-lg px-3 py-2 font-semibold" onClick={() => { setTab("tournament"); setShowResult(false); }}>
                        Voir le tournoi
                      </button>
                    ) : !inTournament ? (
                      <button type="button" className="neon-btn flex-1 rounded-lg px-3 py-2 font-semibold"
                        onClick={() => joinQueue({ timeControl: view.start!.timeControl.id, stake: view.start!.stake })}>
                        Rejouer · {TC_NAME[view.start!.timeControl.id]}
                      </button>
                    ) : null}
                    <button type="button" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text" onClick={() => setShowResult(false)}>
                      Voir l'échiquier
                    </button>
                  </div>
                  {canReportCheat && <div className="mt-3 text-left"><CheatReport opponent={seat(opp)?.userId ?? "ton adversaire"} onReport={reportCheat} resetKey={gameId ?? undefined} /></div>}
                  {view.over.termination !== "aborted" && view.start && (
                    <a href={`/history?g=${view.start.gameId}`} className="mt-3 block text-sm text-neon hover:underline">Analyser avec Stockfish 19 →</a>
                  )}
                </div>
              </div>
            )}
          </div>
          {card(bottom)}
          {(status || (spectators > 0 && view.start)) && (
            <p className="px-2 text-center text-xs text-muted" role="status">
              {status}{spectators > 0 && view.start ? <span className="ml-2 whitespace-nowrap" title="Spectateurs">👁 {spectators} spectateur{spectators > 1 ? "s" : ""}</span> : null}
            </p>
          )}
        </section>

        {/* ─── HUD latéral (sous le plateau sur mobile) ─── */}
        <aside className="flex w-full flex-col gap-3">
          {(view.phase === "idle" || view.phase === "queued" || view.phase === "connecting" || view.phase === "over") && !inTournament && (
            <div className={`panel p-3 ${lobbyFirst ? "hidden lg:block" : ""}`}>
              {view.phase === "over" && <p className="mb-2 text-xs text-muted">Nouvelle partie : même cadence, ou une autre.</p>}
              {lobby}
            </div>
          )}

          {(canRematch || canReportCheat) && !showResult && (
            <div className="panel flex flex-col gap-2 p-3">
              {canRematch && <RematchBox byOpp={rematchByOpp} byMe={rematchByMe} declined={!!rematch?.declined} error={rematchErr}
                opponent={seat(opp)?.userId ?? "Ton adversaire"} onAction={doRematch} />}
              {canReportCheat && <CheatReport opponent={seat(opp)?.userId ?? "ton adversaire"} onReport={reportCheat} resetKey={gameId ?? undefined} />}
            </div>
          )}

          {playing && view.drawOffer && view.drawOffer !== me && (
            <div role="alert" className="panel border-gold/50 p-3">
              <p className="text-sm font-semibold text-gold">Ton adversaire propose la nulle</p>
              <div className="mt-2 flex gap-2">
                <button type="button" className="neon-btn flex-1 rounded-lg px-3 py-2 text-sm font-semibold" onClick={() => draw("accept")}>Accepter</button>
                <button type="button" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text" onClick={() => draw("decline")}>Refuser</button>
              </div>
            </div>
          )}

          {playing && (
            <div className="panel flex gap-2 p-2">
              {!confirmResign && view.server && view.server.ply >= 2 && !(view.drawOffer && view.drawOffer !== me) && (
                <button type="button" disabled={view.drawOffer === me} onClick={() => draw("offer")}
                  className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:border-gold/60 hover:text-gold disabled:opacity-60">
                  {view.drawOffer === me ? "Nulle proposée…" : "½ Proposer la nulle"}
                </button>
              )}
              {confirmResign ? (<>
                <button type="button" className="flex-1 rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-white" onClick={resign}>
                  {view.server && view.server.ply < 2 ? "Confirmer l'annulation" : "Confirmer l'abandon"}
                </button>
                <button type="button" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm" onClick={() => setConfirmResign(false)}>Continuer</button>
              </>) : (
                <button type="button" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:border-danger/60 hover:text-danger" onClick={() => setConfirmResign(true)}>
                  {view.server && view.server.ply < 2 ? "Annuler la partie" : "Abandonner"}
                </button>
              )}
            </div>
          )}

          {sessionBanner(view.session) && (
            <p role="status" className="rounded-lg border border-gold/30 bg-gold/10 p-2.5 text-sm text-gold">{sessionBanner(view.session)}</p>
          )}
          {view.error && errorMessage(view.error) && (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-sm text-danger">{errorMessage(view.error)}</p>
          )}

          <div className="panel p-3">
            <div className="mb-3 flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist">
              {([["moves", "Coups"], ["chat", "Chat"], ["tournament", "Tournoi"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold ${tab === id ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                  {label}{id === "tournament" && sng.current?.status === "running" ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-neon align-middle" /> : null}
                  {id === "chat" && unread > 0 ? <span className="tabular ml-1.5 rounded-full bg-gold px-1.5 text-[10px] text-ink" aria-label={`${unread} message(s) non lu(s)`}>{unread}</span> : null}
                </button>
              ))}
            </div>
            {tab === "moves" ? (
              <div className="flex flex-col gap-2">
                {view.start && liveLast > 0 && <MoveNav compact ply={navPly} last={liveLast} go={go} />}
                <MoveList moves={view.moves} active={navPly - 1} onSelect={view.start ? (p) => go(p + 1) : undefined} />
                {view.phase === "over" && view.start && view.over?.termination !== "aborted" && (
                  <a href={`/history?g=${view.start.gameId}`} className="text-sm text-neon hover:underline">Analyser cette partie avec Stockfish 19 →</a>
                )}
              </div>
            ) : tab === "chat" ? (
              view.start ? (
                <ChatPanel messages={chat} me={userId} onSend={sendChat} onReport={reportChat}
                  quick={view.phase === "over" ? ["Bien joué !", "Merci pour la partie", "gg"] : ["Bonne chance !", "Bien joué", "Oups"]}
                  empty={`Discute avec ${seat(opp)?.userId ?? "ton adversaire"}. Les spectateurs lisent ce chat, mais tu ne vois pas le leur.`} />
              ) : <p className="px-1 text-sm text-muted">Le chat s'ouvre pendant une partie.</p>
            ) : (
              <TournamentHUD userId={userId} current={sng.current} lobby={sng.lobby} busy={sng.busy} error={sng.error}
                onRegister={sng.register} onUnregister={sng.unregister} onCreate={sng.create} onJoin={sng.join} onStart={sng.start} onPause={sng.pause} onWithdraw={sng.withdraw} onKick={sng.kick} invite={sng.invite} chat={tchat} />
            )}
          </div>

          <p className="px-1 text-[11px] leading-relaxed text-muted/70">
            Pendule synchronisée sur le serveur{sync.errorBoundMs !== null ? ` (précision ± ${Math.max(1, Math.round(sync.errorBoundMs))} ms)` : ""}.
            Le serveur arbitre le temps ; l'affichage n'est qu'une projection.
          </p>
        </aside>
      </div>
    </main>
  );
}

/** Décompte local d'un délai annoncé par le serveur (grâce de reconnexion de l'adversaire). */
function useCountdown(ms: number | null, key: unknown): number | null {
  const [left, setLeft] = useState<number | null>(ms);
  useEffect(() => {
    if (ms === null) return setLeft(null);
    const end = Date.now() + ms;
    setLeft(ms);
    const id = setInterval(() => setLeft(Math.max(0, end - Date.now())), 250);
    return () => clearInterval(id);
  }, [ms, key]);
  return left;
}

/** Revanche : proposer, accepter, refuser (dans le résultat de la partie ou le panneau latéral). */
function RematchBox({ byOpp, byMe, declined, error, opponent, onAction }: {
  byOpp: boolean; byMe: boolean; declined: boolean; error: string | null; opponent: string; onAction: (a: "offer" | "decline") => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-neon/30 bg-neon/5 p-2.5 text-left" aria-label="Revanche">
      {byOpp ? (
        <>
          <p className="text-sm font-semibold text-neon">{opponent} propose une revanche</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="neon-btn flex-1 rounded-lg px-3 py-2 text-sm font-semibold" onClick={() => onAction("offer")}>Accepter</button>
            <button type="button" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text" onClick={() => onAction("decline")}>Refuser</button>
          </div>
        </>
      ) : byMe ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted">Revanche proposée… en attente de {opponent}</p>
          <button type="button" className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-text" onClick={() => onAction("decline")}>Annuler</button>
        </div>
      ) : (
        <>
          <button type="button" className="w-full rounded-lg border border-neon/60 px-3 py-2 text-sm font-semibold text-neon hover:bg-neon/10" onClick={() => onAction("offer")}>
            ⟳ Revanche (couleurs inversées)
          </button>
          {declined && <p className="mt-1.5 text-xs text-muted">Revanche refusée.</p>}
        </>
      )}
      {error && <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

