"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Color } from "@chessarena/shared";
import { useDisplayedClocks, useGameSocket } from "../../hooks/useGameSocket";
import { ERROR_MESSAGES, isMyTurn, sessionBanner, START_FEN } from "../../lib/gameReducer";
import { GameBoard } from "../../components/GameBoard";
import { ChessClock } from "../../components/ChessClock";
import { Lobby } from "../../components/Lobby";

const RESULT_LABEL: Record<string, string> = {
  checkmate: "échec et mat", resignation: "abandon", timeout: "temps écoulé", abandon: "forfait (déconnexion)",
  stalemate: "pat", repetition: "triple répétition", insufficient_material: "matériel insuffisant",
  fifty_moves: "règle des 50 coups", aborted: "partie annulée", timeout_vs_insufficient_material: "temps écoulé, matériel insuffisant",
};

export default function PlayPage() {
  return (
    <Suspense>
      <Play />
    </Suspense>
  );
}

/**
 * Identité du joueur : session bêta (cookie posé par la page d'accueil : pseudo + code d'invitation).
 * En développement uniquement, `?u=alice` reste possible (jeton signé par /api/dev-token).
 */
function Play() {
  const params = useSearchParams();
  const router = useRouter();
  const devUser = process.env.NODE_ENV !== "production" ? params.get("u") : null;
  const [me, setMe] = useState<string | null>(devUser);
  useEffect(() => {
    if (devUser) return;
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMe(((await r.json()) as { userId: string }).userId) : router.replace("/")))
      .catch(() => router.replace("/"));
  }, [devUser, router]);
  if (!me) return <main className="grid min-h-dvh place-items-center text-sm text-neutral-500">Chargement…</main>;
  return <Arena userId={me} dev={!!devUser} />;
}

function Arena({ userId, dev }: { userId: string; dev: boolean }) {
  const getAuth = useCallback(async () => {
    const url = dev ? `/api/dev-token?u=${encodeURIComponent(userId)}` : "/api/token";
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? { token: ((await r.json()) as { token: string }).token } : {};
  }, [userId, dev]);

  const { view, offsetRef, joinQueue, leaveQueue, playOrPremove, cancelPremove, resign } = useGameSocket(userId, getAuth);
  const playing = view.phase === "playing";
  const clocks = useDisplayedClocks(view.server, offsetRef, !playing);
  const graceLeft = useCountdown(view.opponentPresence?.graceMs ?? null, view.opponentPresence);
  const [confirmResign, setConfirmResign] = useState(false);
  useEffect(() => setConfirmResign(false), [view.phase]);

  const me: Color = view.myColor;
  const opp: Color = me === "w" ? "b" : "w";
  const seat = (c: Color) => (c === "w" ? view.start?.white : view.start?.black);
  const running = playing && view.server && view.server.ply >= 2 ? view.server.turn : null;
  const myPayout = view.over ? view.over.payouts[userId] : undefined;
  const iWon = useMemo(() => {
    if (!view.over || view.over.result === "1/2-1/2") return null;
    return (view.over.result === "1-0") === (me === "w");
  }, [view.over, me]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 lg:flex-row lg:items-start">
      <section className="w-full lg:max-w-[min(80vh,640px)]">
        <ChessClock ms={view.start ? clocks[opp] : 0} active={running === opp}
          label={seat(opp)?.userId ?? "Adversaire"} rating={seat(opp)?.rating} disconnectedGraceMs={graceLeft} />
        <GameBoard
          fen={view.start ? view.displayFen : START_FEN}
          serverFen={view.server?.fen ?? view.displayFen}
          myColor={me}
          interactive={playing}
          myTurn={isMyTurn(view)}
          lastMove={view.lastMove}
          premove={view.premove}
          onMove={playOrPremove}
          onCancelPremove={cancelPremove}
        />
        <ChessClock ms={view.start ? clocks[me] : 0} active={running === me}
          label={`${userId} (vous)`} rating={seat(me)?.rating} />
      </section>

      <aside className="flex w-full flex-col gap-4 lg:max-w-sm">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">ChessArena</h1>
          <span className={`text-xs ${view.connected ? "text-emerald-600" : "text-amber-600"}`}>
            {view.connected ? "● connecté" : "● reconnexion…"}
          </span>
        </header>

        {(view.phase === "idle" || view.phase === "queued" || view.phase === "connecting") && (
      <>
    <div className="mb-4 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <p className="font-semibold">Jouer à 2 :</p>
      <p className="mt-1 text-neutral-600 dark:text-neutral-400">
        Envoie l'adresse du site et le code d'invitation à ton adversaire. Choisissez tous les deux la même mise et la même cadence.
      </p>
      <button
        className="mt-3 w-full rounded-md bg-blue-600 p-2 font-semibold text-white hover:bg-blue-700"
        onClick={() => void navigator.clipboard.writeText(window.location.origin)}
      >
        📋 Copier l'adresse du site
      </button>
      <button
        className="mt-2 w-full rounded-md border border-neutral-300 p-2 text-neutral-600 dark:border-neutral-700"
        onClick={() => void fetch("/api/session", { method: "DELETE" }).finally(() => { window.location.href = "/"; })}
      >
        Changer de pseudo
      </button>
    </div>
          <Lobby
            queued={view.queue?.timeControl ?? null}
            disabled={!view.connected}
            onJoin={(timeControl, buyInCents) => joinQueue({ timeControl, stake: { currency: "PLAY", buyInCents } })}
            onLeave={leaveQueue}
          />
        </>
        )}

        {playing && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-neutral-500">
              {view.server && view.server.ply < 2
                ? `Jouez votre premier coup dans les 20 s, sinon la partie est annulée.`
                : isMyTurn(view) ? "À vous de jouer." : view.premove ? "Pré-move enregistré (clic droit pour annuler)." : "L'adversaire réfléchit…"}
            </p>
            {confirmResign ? (
              <div className="flex gap-2">
                <button className="flex-1 rounded-md bg-red-600 p-2 font-semibold text-white" onClick={resign}>Confirmer l'abandon</button>
                <button className="flex-1 rounded-md border p-2" onClick={() => setConfirmResign(false)}>Annuler</button>
              </div>
            ) : (
              <button className="rounded-md border border-neutral-300 p-2 dark:border-neutral-700" onClick={() => setConfirmResign(true)}>
                {view.server && view.server.ply < 2 ? "Annuler la partie" : "Abandonner"}
              </button>
            )}
          </div>
        )}

        {view.phase === "over" && view.over && (
          <div className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
            <p className="text-2xl font-bold">
              {view.over.termination === "aborted" ? "Annulée" : iWon === null ? "Nulle" : iWon ? "Victoire" : "Défaite"}
            </p>
            <p className="text-neutral-500">{view.over.result} · {RESULT_LABEL[view.over.termination] ?? view.over.termination}</p>
            {view.over.ratingChanges?.[userId] && (() => {
              const r = view.over.ratingChanges[userId]!;
              const d = r.after - r.before;
              return (
                <p className="mt-1 text-sm">
                  Elo {r.after}{" "}
                  <span className={d >= 0 ? "text-emerald-600" : "text-red-600"}>({d >= 0 ? "+" : ""}{d})</span>
                </p>
              );
            })()}
            {view.start && view.start.stake.buyInCents > 0 && (
              <p className="mt-2 text-sm">
                {myPayout !== undefined ? `Crédité : ${(myPayout / 100).toFixed(2)} jetons` : ""}
                {view.over.rakeCents > 0 && ` · commission ${(view.over.rakeCents / 100).toFixed(2)}`}
              </p>
            )}
            <button className="mt-3 w-full rounded-md bg-emerald-600 p-2 font-semibold text-white"
              onClick={() => joinQueue({ timeControl: view.start!.timeControl.id, stake: view.start!.stake })}>
              Rejouer
            </button>
          </div>
        )}

        {sessionBanner(view.session) && (
          <p role="status" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {sessionBanner(view.session)}
          </p>
        )}

        {view.error && ERROR_MESSAGES[view.error] && (
          <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {ERROR_MESSAGES[view.error]}
          </p>
        )}
      </aside>
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
