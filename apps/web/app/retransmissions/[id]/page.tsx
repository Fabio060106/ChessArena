"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RelayGameView, RelayRoundView } from "@chessarena/shared";
import { PageHeader } from "../../../components/PageHeader";
import { GameBoard } from "../../../components/GameBoard";
import { MoveList } from "../../../components/MoveList";
import { MoveNav, usePlyKeys } from "../../../components/MoveNav";
import { ChatPanel } from "../../../components/ChatPanel";
import { PredictionPanel } from "../../../components/PredictionPanel";
import { usePredictions } from "../../../hooks/usePredictions";
import { formatMoney } from "../../../lib/tournament";
import { GameReviewPanel } from "../../../components/GameReviewPanel";
import { FlipButton } from "../../../components/SiteNav";
import { useGameAuth, useMe } from "../../../hooks/useMe";
import { formatClock, relayClock, useRelay } from "../../../hooks/useRelay";
import { useFlip } from "../../../hooks/useFlip";
import { useSettings } from "../../../lib/settings";
import { matchScore, nextRound, points, shortName, untilText, whenText } from "../../../lib/relayFormat";
import { replayFromSans } from "../../../lib/replay";
import { Engine, ENGINE_NAME, formatScore, pvToSan, scoreToCp, terminalScore, winPct, type EngineLine } from "../../../lib/engine";

/** Suivre un tournoi officiel en direct (échiquiers électroniques DGT). */
export default function RelayPage() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const valid = typeof id === "string" && /^[0-9a-f]{8}$/.test(id);
  return (
    <main className="arena-app">
      <PageHeader title="Retransmission" active="/direct" />
      {!valid ? <p className="mx-auto max-w-[700px] p-4 text-sm text-danger">Lien de retransmission invalide.</p>
        : me ? <Relay relayId={id} me={me.userId} /> : <p className="p-4 text-sm text-muted">Chargement…</p>}
    </main>
  );
}

function Relay({ relayId, me }: { relayId: string; me: string }) {
  const getAuth = useGameAuth();
  const { round: liveRound, missing, connected, chat, sendChat, reportChat, loadRound } = useRelay(relayId, getAuth);
  const pred = usePredictions(relayId, getAuth);
  const [pick, setPick] = useState<number | null>(null);
  // ronde déjà jouée choisie par le spectateur (null = la ronde en direct)
  const [past, setPast] = useState<{ n: number; view: RelayRoundView | null } | null>(null);
  const chooseRound = (n: number) => {
    setPick(null);
    if (n === liveRound?.currentRound) { setPast(null); return; }
    setPast({ n, view: null });
    void loadRound(n).then((view) => setPast((p) => (p && p.n === n ? { n, view } : p)));
  };

  if (missing) return <p className="mx-auto max-w-[700px] p-4 text-sm text-muted">Cette retransmission n'existe plus. <a href="/direct" className="text-neon underline">Voir ce qui est en direct</a>.</p>;
  if (!liveRound) return <p className="mx-auto max-w-[700px] p-4 text-sm text-muted">Connexion à la retransmission… (le serveur peut mettre une minute à se réveiller)</p>;
  const round = past?.view ?? liveRound;
  const shownNo = past ? past.n : liveRound.currentRound;
  const roundsList = liveRound.rounds ?? [];

  const games = round.gameList;
  const game = games.find((g) => g.index === pick) ?? games.find((g) => g.live) ?? games[0] ?? null;
  const header = (
    <>
      <div className="panel flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
        <h1 className="font-display text-lg font-bold">{round.name}</h1>
        <span className="text-sm text-muted">{round.currentRound ? round.roundName ?? `Ronde ${round.currentRound}` : "Connexion à la source…"}</span>
        {!past && round.live && <span className="text-xs font-semibold text-danger"><span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle" />En direct</span>}
        {!connected && <span className="text-xs text-gold">reconnexion…</span>}
        {round.error && <span role="status" className="w-full text-xs text-gold">{round.error}</span>}
        {past && <button type="button" onClick={() => setPast(null)} className="text-xs text-neon hover:underline">← revenir au direct</button>}
      </div>
      <MatchInfo round={liveRound} />
      {roundsList.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Rondes du tournoi">
          {roundsList.filter((r) => r.state !== "upcoming").map((r) => (
            <button key={r.number} type="button" role="tab" aria-selected={shownNo === r.number} onClick={() => chooseRound(r.number)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs ${shownNo === r.number ? "border-neon bg-neon/10 font-semibold" : "border-line text-muted hover:bg-surface-2"}`}>
              {r.name}{r.state === "ongoing" ? " •" : r.state === "finished" ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}
      {past && !past.view && <p className="panel p-3 text-sm text-muted">Chargement de {roundsList.find((r) => r.number === past.n)?.name ?? `la ronde ${past.n}`}…</p>}
      {games.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Parties de la ronde">
          {games.map((g) => (
            <button key={g.index} type="button" role="tab" aria-selected={game?.index === g.index} onClick={() => setPick(g.index)}
              className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-xs ${game?.index === g.index ? "border-neon bg-neon/10" : "border-line hover:bg-surface-2"}`}>
              <span className="block font-semibold">{short(g.white.name)} – {short(g.black.name)}</span>
              <span className="text-muted">{g.result ?? (g.live ? "en cours" : g.sans.length ? "…" : "pas commencée")}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
  const chatPanel = (
    <ChatPanel messages={chat} me={me} onSend={sendChat} onReport={reportChat} placeholder="Commenter avec les autres spectateurs…"
      quick={["Joli coup !", "Quelle partie", "😮"]} empty="Personne n'a encore écrit. Lance la discussion !" />
  );
  if (!game) {
    return (
      <div className="mx-auto flex max-w-[900px] flex-col gap-3 px-2 pb-6 sm:px-3">
        {header}
        <p className="panel p-4 text-sm text-muted">Les parties de cette ronde n'ont pas encore commencé. La page se met à jour toute seule : les coups s'afficheront ici en direct.</p>
        <div className="panel p-3">{chatPanel}</div>
      </div>
    );
  }
  // pronostics : seulement sur la ronde en direct (une ronde passée est déjà réglée)
  const odds = !past && shownNo ? pred.oddsFor(shownNo, game.index) : null;
  const predictionPanel = !past && shownNo && (game.live || odds) ? (
    <PredictionPanel game={game} round={shownNo} odds={odds} mine={pred.mine}
      onPlace={(pick, stake, version) => pred.place(shownNo, game.index, pick, stake, version)} />
  ) : null;
  const settled = pred.lastSettled && (
    <button type="button" onClick={pred.dismissSettled} role="status"
      className={`fixed inset-x-2 bottom-20 z-[90] mx-auto max-w-[360px] rounded-xl border p-3 text-left text-sm shadow-2xl sm:bottom-4 ${pred.lastSettled.status === "won" ? "border-win/60 bg-ink text-win" : "border-line bg-ink text-muted"}`}>
      {pred.lastSettled.status === "won" ? `🎉 Pronostic gagné : +${formatMoney(pred.lastSettled.payoutCents - pred.lastSettled.stakeCents, "PLAY")}` : pred.lastSettled.status === "lost" ? "Pronostic perdu" : "Pronostic remboursé"}
      <span className="block text-xs text-muted">{pred.lastSettled.label}</span>
    </button>
  );
  return <>{settled}<RelayGame key={`${shownNo}-${game.index}`} relayId={relayId} roundNo={shownNo} game={game} header={header} chatPanel={chatPanel} chatCount={chat.length} predictionPanel={predictionPanel} /></>;
}

/** Score du match (ou tête du classement) et heure de la prochaine partie, à l'heure du spectateur. */
function MatchInfo({ round }: { round: RelayRoundView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const score = matchScore(round.standings);
  const next = round.live ? null : nextRound(round.rounds, now);
  if (!score && !round.standings?.length && !next) return null;
  return (
    <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
      {score ? (
        <div className="flex items-center gap-2" aria-label="Score du match">
          <span className="text-sm font-semibold">{score.a.title ? <span className="mr-1 text-gold">{score.a.title}</span> : null}{shortName(score.a.name)}</span>
          <span className="tabular rounded-md bg-surface-2 px-2 py-0.5 font-display text-lg font-bold">{points(score.a.score)} – {points(score.b.score)}</span>
          <span className="text-sm font-semibold">{shortName(score.b.name)}{score.b.title ? <span className="ml-1 text-gold">{score.b.title}</span> : null}</span>
        </div>
      ) : round.standings?.length ? (
        <ol className="flex flex-wrap gap-x-3 text-xs text-muted" aria-label="Classement">
          {round.standings.slice(0, 5).map((p, i) => <li key={p.name}><span className="font-semibold text-text">{i + 1}. {p.name}</span> {points(p.score)}/{p.played}</li>)}
        </ol>
      ) : null}
      {next && (
        <span className="text-xs text-muted">
          Prochaine partie : <span className="font-semibold text-text">{next.name}</span> · {whenText(next.startsAt!)} ({untilText(next.startsAt!, now)})
        </span>
      )}
    </div>
  );
}

const short = (n: string) => (n.length > 18 ? n.split(" ").at(-1) ?? n : n);

/** Une partie retransmise : pendules, navigation dans les coups, évaluation, lien vers l'analyse, chat. */
function RelayGame({ relayId, roundNo, game, header, chatPanel, chatCount, predictionPanel }: {
  relayId: string; roundNo: number | null; game: RelayGameView; header: React.ReactNode; chatPanel: React.ReactNode; chatCount: number; predictionPanel?: React.ReactNode;
}) {
  const [settings] = useSettings();
  const getAuth = useGameAuth();
  const [flipped, flip] = useFlip();
  const [tab, setTab] = useState<"moves" | "chat">("moves");
  const steps = useMemo(() => replayFromSans(game.sans), [game.sans]);
  const last = steps.length - 1;
  const [browse, setBrowse] = useState<number | null>(null);
  const browsing = browse !== null && browse < last;
  const ply = browsing ? browse : last;
  const go = useCallback((p: number) => { const c = Math.max(0, Math.min(last, p)); setBrowse(c >= last ? null : c); }, [last]);
  usePlyKeys(ply, last, go, last > 0);
  const fen = steps[ply]!.fen;

  // pendules : celle du joueur au trait tourne entre deux mises à jour
  const receivedAt = useRef(Date.now());
  useEffect(() => { receivedAt.current = Date.now(); }, [game.sans.length, game.clocks.w, game.clocks.b]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!game.live) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [game.live]);

  const eng = useLiveEval(fen);
  const bottom: "w" | "b" = flipped ? "b" : "w";
  const top: "w" | "b" = bottom === "w" ? "b" : "w";
  const row = (c: "w" | "b") => {
    const p = c === "w" ? game.white : game.black;
    const sec = relayClock(game, c, now, receivedAt.current);
    const running = game.live && !game.result && game.turn === c && game.sans.length > 0;
    return (
      <div className="panel flex items-center gap-2 px-3 py-2 max-lg:rounded-lg max-lg:px-2 max-lg:py-0.5">
        <span className={`size-3 shrink-0 rounded-sm border border-line ${c === "w" ? "bg-[#f3f3f3]" : "bg-[#222]"}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm">
          {p.title && <span className="mr-1 font-semibold text-gold">{p.title}</span>}
          {p.fideId ? <a href={`https://ratings.fide.com/profile/${p.fideId}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{p.name}</a> : <span className="font-semibold">{p.name}</span>}
          {game.result && <span className="ml-2 text-muted">{c === "w" ? game.result.split("-")[0] : game.result.split("-")[1]}</span>}
        </span>
        <span role="timer" aria-label={`Pendule ${c === "w" ? "des Blancs" : "des Noirs"}`}
          className={`tabular rounded-md px-2 py-0.5 font-display text-lg max-lg:text-sm ${running ? "bg-neon/15 text-neon" : "text-muted"} ${sec !== null && sec < 300 && running ? "!text-danger" : ""}`}>
          {formatClock(sec)}
        </span>
      </div>
    );
  };
  const bestSan = eng.line?.pv[0] ? pvToSan(fen, eng.line.pv, 5).join(" ") : null;

  return (
    <>
    {/* téléphone : l'en-tête défile normalement, l'échiquier reste ensuite collé en haut de l'écran pendant qu'on lit les coups */}
    <div className="mx-auto max-w-[1400px] px-2 pb-2 sm:px-3 lg:hidden">{header}</div>
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-2 pb-6 sm:px-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:px-6">
      <div className="flex min-w-0 flex-col gap-2 max-lg:sticky max-lg:top-0 max-lg:z-30 max-lg:-mx-2 max-lg:border-b max-lg:border-line max-lg:bg-ink max-lg:px-2 max-lg:pb-1.5 max-lg:pt-1 max-lg:shadow-lg">
        <div className="max-lg:hidden">{header}</div>
        <section data-board className="mx-auto flex w-full flex-col gap-1 lg:gap-1.5 max-w-[min(100%,44dvh)] sm:max-w-[min(100%,48dvh)] lg:max-w-[min(100%,max(320px,calc(100dvh_-_340px)))]">
          {row(top)}
          <EvalBar cp={eng.cp} flip={bottom === "b"} />
          <div className="relative">
            <GameBoard fen={fen} serverFen={fen} orientation={bottom} myColor={bottom} interactive={false} myTurn={false}
              lastMove={steps[ply]!.uci} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
              onMove={() => false} onCancelPremoves={() => {}}
              arrows={eng.line?.pv[0] ? [{ from: eng.line.pv[0].slice(0, 2), to: eng.line.pv[0].slice(2, 4), color: "#22d3ee99" }] : []} />
            {browsing && (
              <button type="button" onClick={() => setBrowse(null)}
                className="absolute left-1/2 top-2 z-[45] -translate-x-1/2 rounded-full border border-gold/60 bg-ink/85 px-3 py-1 text-xs font-semibold text-gold shadow-lg backdrop-blur">
                {game.live ? "revenir au direct ⏭" : "dernière position ⏭"}
              </button>
            )}
          </div>
          {row(bottom)}
          {/* téléphone : navigation, évaluation et outils sur une seule ligne compacte */}
          <div className="flex items-center gap-1.5 lg:hidden">
            {last > 0 && <div className="min-w-0 flex-1 [&_button]:!px-0 [&_button]:!py-1 [&_button]:!text-sm"><MoveNav compact ply={ply} last={last} go={go} /></div>}
            <span className="tabular shrink-0 text-xs font-semibold">{eng.label.split(" ·")[0]}</span>
            <a href={`/analyse?m=${game.ucis.slice(0, ply).join(",")}`} aria-label="Analyser cette position" className="shrink-0 rounded-lg border border-neon/50 px-2 py-1 text-xs font-semibold text-neon">Analyser</a>
            <FlipButton onFlip={flip} />
          </div>
          <p role="status" className={`px-1 text-center text-sm ${game.result ? "max-lg:hidden" : "max-lg:text-xs"}`}>
            {game.result
              ? <span className="font-semibold">Partie terminée · {game.result} — {game.result === "1/2-1/2" ? "nulle" : `victoire de ${game.result === "1-0" ? game.white.name : game.black.name}`}</span>
              : game.live ? <span className="text-muted">En direct · trait aux {game.turn === "w" ? "Blancs" : "Noirs"}</span>
              : <span className="text-muted">{game.sans.length ? "Partie en cours (pendules arrêtées)" : "Pas encore commencée"}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-2 px-1 text-sm max-lg:hidden">
            <span className="tabular font-semibold">{eng.label}</span>
            {bestSan && <span className="min-w-0 flex-1 truncate text-xs text-muted max-lg:hidden">{bestSan}</span>}
            <a href={`/analyse?m=${game.ucis.slice(0, ply).join(",")}`} className="rounded-lg border border-neon/50 px-2.5 py-1 text-xs font-semibold text-neon hover:bg-neon/10">Analyser cette position</a>
            <FlipButton onFlip={flip} />
          </div>
        </section>
      </div>
      <aside className="flex w-full min-w-0 flex-col gap-3">
        {predictionPanel}
        {game.result && game.sans.length > 0 && (
          <GameReviewPanel relayId={relayId} round={roundNo ?? 0} index={game.index} sans={game.sans} ucis={game.ucis} getAuth={getAuth}
            names={{ w: game.white.name, b: game.black.name }} result={game.result} onGo={go} ply={ply} />
        )}
        <div className="panel p-3">
          <div className="mb-3 flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist">
            {([["moves", "Coups"], ["chat", `Chat${chatCount ? ` (${chatCount})` : ""}`]] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm font-semibold ${tab === k ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>{label}</button>
            ))}
          </div>
          {tab === "chat" ? chatPanel : (
            <div className="flex flex-col gap-2">
              {last > 0 && <MoveNav compact ply={ply} last={last} go={go} />}
              <MoveList moves={game.sans} active={ply - 1} onSelect={(p) => go(p + 1)} />
              {game.sans.length === 0 && <p className="text-sm text-muted">Aucun coup pour l'instant.</p>}
            </div>
          )}
        </div>
        <p className="px-1 text-[11px] text-muted/80">
          Coups transmis en direct depuis le tournoi (échiquiers électroniques DGT ou retransmission Lichess), avec le léger décalage imposé par l'organisateur.
          L'évaluation est calculée par {ENGINE_NAME} dans ton navigateur.
        </p>
      </aside>
    </div>
    </>
  );
}

function EvalBar({ cp, flip }: { cp: number | null; flip: boolean }) {
  const w = cp === null ? 50 : winPct(cp);
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-[#1C2233] ring-1 ring-line" aria-label="Barre d'évaluation">
      <div className="absolute inset-y-0 bg-[#E7ECF3] transition-all duration-300" style={flip ? { right: 0, width: `${w}%` } : { left: 0, width: `${w}%` }} />
      <div className="absolute inset-y-0 left-1/2 w-px bg-neon/60" />
    </div>
  );
}

/** Évaluation Stockfish (navigateur) de la position affichée. */
function useLiveEval(fen: string) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [line, setLine] = useState<EngineLine | null>(null);
  useEffect(() => {
    let e: Engine | null = null;
    try { e = new Engine(); setEngine(e); } catch { /* moteur indisponible */ }
    return () => e?.terminate();
  }, []);
  useEffect(() => {
    setLine(null);
    if (!engine || terminalScore(fen)) return;
    let live = true;
    void engine.analyse(fen, 20, (l) => { if (live) setLine(l); });
    return () => { live = false; };
  }, [engine, fen]);
  const t = terminalScore(fen);
  const score = t ?? line?.score ?? null;
  return {
    line: t ? null : line,
    cp: score ? scoreToCp(score) : null,
    label: score ? `${formatScore(score)}${line && !t ? ` · prof. ${line.depth}` : ""}` : "Évaluation…",
  };
}
