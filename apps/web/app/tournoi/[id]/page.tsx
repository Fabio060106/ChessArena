"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { SngSnapshot } from "@chessarena/shared";
import { PageHeader } from "../../../components/PageHeader";
import { SNG_ERRORS, TournamentHUD } from "../../../components/TournamentHUD";
import { useGameAuth, useMe } from "../../../hooks/useMe";
import { useTournament } from "../../../hooks/useTournament";
import { getSocket } from "../../../lib/socket";
import { arenaJoinable } from "../../../lib/tournament";
import { TournamentTV } from "../../../components/TournamentTV";

export default function TournamentPage() {
  return <Suspense><Page /></Suspense>;
}

/**
 * Page d'un tournoi, à partager : classement et rondes en direct pour tout le monde (joueurs du club, spectateurs),
 * puis classement final. On s'inscrit et on joue depuis la page de jeu (/play?t=…).
 */
function Page() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const [snap, setSnap] = useState<SngSnapshot | null | "none" | "error">(null);
  useEffect(() => {
    if (!me) return;
    fetch(`/api/tournaments/${id}`, { cache: "no-store" })
      .then(async (r) => setSnap(r.ok ? ((await r.json()) as SngSnapshot) : r.status === 404 ? "none" : "error"))
      .catch(() => setSnap("error"));
  }, [me, id]);
  return (
    <main className="arena-app">
      <PageHeader title="Tournoi" active="/tournois" />
      <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-2 pb-8 sm:px-3">
        {snap === null ? <p className="panel p-4 text-sm text-muted">Chargement…</p>
          : snap === "none" ? <p className="panel p-4 text-sm text-danger">Ce tournoi n'existe pas (ou plus). <a href="/play" className="text-neon underline">Voir les tournois ouverts</a></p>
          : snap === "error" ? <p className="panel p-4 text-sm text-danger">Impossible de charger le tournoi (le serveur se réveille peut-être : réessaie dans une minute).</p>
          : me && <Live initial={snap} userId={me.userId} />}
      </div>
    </main>
  );
}

function Live({ initial, userId }: { initial: SngSnapshot; userId: string }) {
  const getAuth = useGameAuth();
  const socket = useMemo(() => getSocket(getAuth), [getAuth]);
  const sng = useTournament(socket, userId);
  const [t, setT] = useState(initial);
  // en direct : on suit le tournoi (même sans y jouer) ; un tournoi terminé depuis longtemps n'est plus en mémoire
  useEffect(() => {
    const watch = () => socket.emit("sng:watch", { tournamentId: initial.id }, (r) => { if (r.ok) setT(r.snapshot); });
    const onUpdate = (s: SngSnapshot) => { if (s.id === initial.id) setT(s); };
    socket.on("sng:update", onUpdate);
    socket.on("connect", watch);
    if (socket.connected) watch();
    return () => {
      socket.off("sng:update", onUpdate);
      socket.off("connect", watch);
      socket.emit("sng:unwatch", { tournamentId: initial.id });
    };
  }, [socket, initial.id]);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // « Rejoindre » : inscription ici, puis page de jeu (où les parties démarrent)
  const join = () => {
    setJoining(true);
    setJoinError(null);
    socket.emit("sng:join", { tournamentId: t.id }, (r) => {
      if (r.ok) { window.location.href = `/play?t=${t.id}`; return; }
      setJoining(false);
      setJoinError(SNG_ERRORS[r.code] ?? "Inscription impossible pour le moment.");
    });
  };
  const mine = t.players.some((p) => p.userId === userId && p.status !== "unregistered" && p.status !== "refunded");
  const live = t.status === "running" || t.status === "registering";
  return (
    <>
      {(t.status === "registering" || arenaJoinable(t)) && !mine && (
        <button type="button" disabled={joining} onClick={join} className="neon-btn rounded-xl px-4 py-3 text-center font-display text-lg font-bold">
          {joining ? "Inscription…" : arenaJoinable(t) ? "Rejoindre l'arena en cours" : "Rejoindre le tournoi"}
        </button>
      )}
      {joinError && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{joinError}</p>}
      {mine && live && (
        <a href={`/play?t=${t.id}`} className="rounded-xl border border-neon/50 px-4 py-2.5 text-center text-sm font-semibold text-neon">
          {t.status === "running" ? "Aller jouer ma partie →" : "Page de jeu (tes parties démarreront là) →"}
        </a>
      )}
      <TournamentTV t={t} userId={userId} />
      <TournamentHUD userId={userId} current={t} lobby={[]} busy={sng.busy} error={sng.error}
        onRegister={() => {}} onUnregister={sng.unregister} onCreate={() => {}} onJoin={sng.join} onStart={sng.start} onPause={sng.pause} onWithdraw={sng.withdraw} onKick={sng.kick} invite={null} pageLink={false} />
    </>
  );
}
