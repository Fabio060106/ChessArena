"use client";
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { PageHeader } from "../../../components/PageHeader";
import { GameReplay } from "../../../components/GameReplay";
import { useMe } from "../../../hooks/useMe";

export default function SharedGamePage() {
  return <Suspense><SharedGame /></Suspense>;
}

/** Analyse partagée par lien : la partie, à la position (et avec la variante) choisie par celui qui partage. */
function SharedGame() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const valid = typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);
  const plyRaw = Number(q.get("ply"));
  const ply = q.get("ply") !== null && Number.isInteger(plyRaw) && plyRaw >= 0 && plyRaw < 1000 ? plyRaw : undefined;
  const variation = (q.get("v") ?? "").split(",").filter((u) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)).slice(0, 60);
  return (
    <main className="arena-app">
      <PageHeader title="Analyse partagée" />
      <div className="mx-auto max-w-[900px] px-2 pb-8 sm:px-3">
        {!valid ? <p className="panel p-4 text-sm text-danger">Lien de partie invalide.</p>
          : me ? <GameReplay gameId={id} me={me.userId} publicView initial={{ ply, variation }} />
          : <p className="panel p-4 text-sm text-muted">Chargement…</p>}
      </div>
    </main>
  );
}
