"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Color } from "@chessarena/shared";
import { useClockTicker, useGameSocket } from "../../hooks/useGameSocket";
import { useTournament } from "../../hooks/useTournament";
import { ERROR_MESSAGES, isMyTurn, sessionBanner, START_FEN } from "../../lib/gameReducer";
import { BOARD_THEMES, THEME_ORDER } from "../../lib/boardThemes";
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
import { Lobby } from "../../components/Lobby";

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
  return <Arena userId={me.userId} flag={me.flag ?? ""} dev={!!devUser} inviteId={invite && /^[0-9a-f-]{36}$/i.test(invite) ? invite : null} />;
}

const TC_NAME = { bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0" } as const;

function Arena({ userId, flag, dev, inviteId }: { userId: string; flag: string; dev: boolean; inviteId: string | null }) {
  const getAuth = useCallback(async () => {
    const url = dev ? `/api/dev-token?${new URLSearchParams({ u: userId, ...(flag ? { flag } : {}) })}` : "/api/token";
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? { token: ((await r.json()) as { token: string }).token } : {};
  }, [userId, flag, dev]);

  const { view, socket, sync, localRtt, joinQueue, leaveQueue, playOrPremove, cancelPremoves, resign, draw } = useGameSocket(userId, getAuth);
  const sng = useTournament(socket, userId, inviteId);
  const [settings, updateSettings] = useSettings();
  const playing = view.phase === "playing";
  const subscribe = useClockTicker(view.server, sync, !playing);
  const graceLeft = useCountdown(view.opponentPresence?.graceMs ?? null, view.opponentPresence);
  const [confirmResign, setConfirmResign] = useState(false);
  const [tab, setTab] = useState<"tournament" | "moves">(inviteId ? "tournament" : "moves");
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
  useEffect(() => { if (gameId) window.scrollTo({ top: 0, behavior: "smooth" }); setBrowse(null); }, [gameId]);
  useEffect(() => { if (sng.current && !playing) setTab("tournament"); }, [sng.current, playing]);

  // le contexte audio ne peut démarrer que sur un geste : premier clic n'importe où
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, []);

  const me: Color = view.myColor;
  const opp: Color = me === "w" ? "b" : "w";
  const seat = (c: Color) => (c === "w" ? view.start?.white : view.start?.black);
  const running = playing && view.server && view.server.ply >= 2 ? view.server.turn : null;
  const fen = browsing ? steps[browse]!.fen : view.start ? view.displayFen : START_FEN;
  const initialMs = view.start?.timeControl.initialMs ?? 0;
  const myTurn = isMyTurn(view) && view.premoves.length === 0;
  const mat = useMemo(() => material(fen), [fen]);
  const inTournament = !!sng.current && (sng.current.status === "running" || sng.current.players.some((p) => p.userId === userId && p.status === "registered"));
  const lobby = (
    <Lobby
      queued={view.queue?.timeControl ?? null}
      queuedStake={view.queue?.stake.buyInCents ?? null}
      defaultStake={view.queue?.stake.buyInCents ?? view.start?.stake.buyInCents}
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

  const plyLabel = (p: number) => (p === 0 ? "position de départ" : `${Math.ceil(p / 2)}${p % 2 === 1 ? "." : "…"} ${steps[p]?.san ?? ""}`);
  const status = !playing ? null
    : browsing ? `Vous regardez ${plyLabel(browse!)} — la partie continue. ⏭, → ou un clic sur l'échiquier pour revenir.`
    : view.server && view.server.ply < 2 ? "Jouez votre premier coup dans les 20 s, sinon la partie est annulée."
    : isMyTurn(view) ? "À vous de jouer."
    : view.premoves.length ? `${view.premoves.length} pré-move${view.premoves.length > 1 ? "s" : ""} en file · clic droit ou Échap pour annuler`
    : "L'adversaire réfléchit…";

  return (
    <main className="arena-app">
      <header className="mx-auto flex h-13 max-w-[1400px] items-center gap-3 px-3 lg:px-6">
        <h1 className="font-display text-lg font-bold tracking-tight">
          Chess<span className="text-neon">Arena</span>
        </h1>
        <span className={`flex items-center gap-1.5 text-xs ${view.connected ? "text-win" : "text-gold"}`}>
          <span className={`size-1.5 rounded-full ${view.connected ? "bg-win" : "animate-pulse bg-gold"}`} />
          {view.connected ? "connecté" : "reconnexion…"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <a href="/history" className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">Mes parties</a>
          {!dev && (
            <button type="button" title="Se déconnecter"
              onClick={() => void fetch("/api/session", { method: "DELETE" }).finally(() => { window.location.href = "/"; })}
              className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">
              Quitter
            </button>
          )}
          <div className="flex rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="Thème de l'échiquier">
            {THEME_ORDER.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={settings.boardTheme === id} title={BOARD_THEMES[id].label}
                onClick={() => updateSettings({ boardTheme: id })}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${settings.boardTheme === id ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                <span className="size-3 rounded-sm" style={{ background: `linear-gradient(135deg, ${BOARD_THEMES[id].vars["--sq-light"]} 50%, ${BOARD_THEMES[id].vars["--sq-dark"]} 50%)` }} />
                <span className="hidden sm:inline">{BOARD_THEMES[id].label}</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={() => updateSettings({ soundOn: !settings.soundOn })} aria-pressed={settings.soundOn}
            title={settings.soundOn ? "Couper le son" : "Activer le son"} className="rounded-lg bg-surface-2 px-2 py-1.5 text-xs text-muted hover:text-text">
            {settings.soundOn ? "🔊" : "🔇"}
          </button>
          <button type="button" onClick={() => updateSettings({ coordinates: !settings.coordinates })} aria-pressed={settings.coordinates}
            title="Coordonnées" className="hidden rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-xs text-muted hover:text-text sm:block">
            a1
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1400px] gap-4 px-2 pb-6 sm:px-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:px-6">
        {/* ─── Zone de jeu : la taille du plateau suit la hauteur ET la largeur disponibles ─── */}
        <section className="mx-auto flex w-full flex-col gap-1.5" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 200px)))" }}>
          <PlayerCard
            userId={seat(opp)?.userId ?? "Adversaire"} rating={seat(opp)?.rating} flag={seat(opp)?.flag}
            pingMs={view.start ? pingOf(opp) : null} toMove={running === opp} graceMs={graceLeft}
            materialAdvantage={view.start ? materialAdvantage(fen, opp) : 0} captured={view.start ? mat[opp].captured : undefined}
            clock={<ChessClock color={opp} subscribe={subscribe} active={running === opp} initialMs={initialMs} alert={false} />}
          />
          <div className="relative" onPointerDownCapture={(e) => {
            // en navigation, un clic sur le plateau ramène au direct SANS jouer : on ne joue jamais depuis une position passée
            if (browsing) { e.stopPropagation(); e.preventDefault(); setBrowse(null); }
          }}>
            <GameBoard
              fen={fen}
              serverFen={browsing ? fen : (view.server?.fen ?? fen)}
              orientation={me}
              myColor={me}
              interactive={playing && !browsing}
              myTurn={myTurn}
              lastMove={browsing ? steps[browse]!.uci : view.lastMove}
              premoves={browsing ? [] : view.premoves}
              theme={settings.boardTheme}
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
                  <p className={`font-display text-3xl font-bold ${view.over.termination === "aborted" || iWon === null ? "text-text" : iWon ? "text-win" : "text-danger"}`}>
                    {view.over.termination === "aborted" ? "Partie annulée" : iWon === null ? "Nulle" : iWon ? "Victoire" : "Défaite"}
                  </p>
                  <p className="mt-1 text-sm text-muted">{view.over.result} · {RESULT_LABEL[view.over.termination] ?? view.over.termination}</p>
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
                  <div className="mt-4 flex gap-2">
                    {sng.current?.status !== "running" ? (
                      <button type="button" className="neon-btn flex-1 rounded-lg px-3 py-2 font-semibold"
                        onClick={() => joinQueue({ timeControl: view.start!.timeControl.id, stake: view.start!.stake })}>
                        Rejouer · {TC_NAME[view.start!.timeControl.id]}
                      </button>
                    ) : null}
                    <button type="button" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text" onClick={() => setShowResult(false)}>
                      Voir l'échiquier
                    </button>
                  </div>
                  {view.over.termination !== "aborted" && view.start && (
                    <a href={`/history?g=${view.start.gameId}`} className="mt-3 block text-sm text-neon hover:underline">Analyser avec Stockfish 19 →</a>
                  )}
                </div>
              </div>
            )}
          </div>
          <PlayerCard
            userId={view.start ? (seat(me)?.userId ?? userId) : userId} rating={seat(me)?.rating} flag={seat(me)?.flag ?? (flag || undefined)}
            pingMs={pingOf(me)} isMe toMove={running === me}
            materialAdvantage={view.start ? materialAdvantage(fen, me) : 0} captured={view.start ? mat[me].captured : undefined}
            clock={<ChessClock color={me} subscribe={subscribe} active={running === me} initialMs={initialMs} alert />}
          />
          {status && <p className="px-2 text-center text-xs text-muted" role="status">{status}</p>}
        </section>

        {/* ─── HUD latéral (sous le plateau sur mobile) ─── */}
        <aside className="flex w-full flex-col gap-3">
          {(view.phase === "idle" || view.phase === "queued" || view.phase === "connecting" || view.phase === "over") && !inTournament && (
            <div className="panel p-3">
              {view.phase === "over" && <p className="mb-2 text-xs text-muted">Nouvelle partie : même cadence, ou une autre.</p>}
              {lobby}
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
          {view.error && ERROR_MESSAGES[view.error] && (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-sm text-danger">{ERROR_MESSAGES[view.error]}</p>
          )}

          <div className="panel p-3">
            <div className="mb-3 flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist">
              {([["moves", "Coups"], ["tournament", "Tournoi"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold ${tab === id ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                  {label}{id === "tournament" && sng.current?.status === "running" ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-neon align-middle" /> : null}
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
            ) : (
              <TournamentHUD userId={userId} current={sng.current} lobby={sng.lobby} busy={sng.busy} error={sng.error}
                onRegister={sng.register} onUnregister={sng.unregister} onCreate={sng.create} onJoin={sng.join} invite={sng.invite} />
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
