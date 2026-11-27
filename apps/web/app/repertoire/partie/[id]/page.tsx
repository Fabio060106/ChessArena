"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { RepertoireGame, RepertoireResponse } from "@chessarena/shared";
import { PageHeader } from "../../../../components/PageHeader";
import { GameBoard } from "../../../../components/GameBoard";
import { MoveList } from "../../../../components/MoveList";
import { MoveNav, usePlyKeys } from "../../../../components/MoveNav";
import { GameReviewPanel } from "../../../../components/GameReviewPanel";
import { FlipButton } from "../../../../components/SiteNav";
import { useMe } from "../../../../hooks/useMe";
import { useSettings } from "../../../../lib/settings";
import { replayFromPgn } from "../../../../lib/replay";

export default function OwnGamePage() {
  return <Suspense><OwnGame /></Suspense>;
}

const resultOf = (g: RepertoireGame) => g.outcome === "draw" ? "1/2-1/2" : (g.outcome === "win") === (g.color === "w") ? "1-0" : "0-1";

/** Une partie du joueur (jouée sur le site, importée de Lichess ou d'un fichier PGN), commentée coup par coup comme dans un livre. */
function OwnGame() {
  const me = useMe();
  const { id: raw } = useParams<{ id: string }>();
  const id = decodeURIComponent(raw ?? "");
  const [game, setGame] = useState<RepertoireGame | null | "none" | "error">(null);
  useEffect(() => {
    if (!me) return;
    fetch("/api/repertoire", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const d = (await r.json()) as RepertoireResponse;
        setGame(d.games.find((g) => g.gameId === id) ?? "none");
      })
      .catch(() => setGame("error"));
  }, [me, id]);
  return (
    <main className="arena-app">
      <PageHeader title="Ma partie commentée" active="/repertoire" />
      {game === null ? <p className="p-4 text-sm text-muted">Chargement…</p>
        : game === "none" ? <p className="mx-auto max-w-[700px] p-4 text-sm text-danger">Cette partie n'est pas (ou plus) dans tes parties. <a className="text-neon underline" href="/repertoire">Retour au répertoire</a></p>
        : game === "error" ? <p className="mx-auto max-w-[700px] p-4 text-sm text-danger">Impossible de charger tes parties (le serveur se réveille peut-être : réessaie dans une minute).</p>
        : <Review game={game} me={me?.userId ?? "Moi"} />}
    </main>
  );
}

function Review({ game, me }: { game: RepertoireGame; me: string }) {
  const [settings] = useSettings();
  const steps = useMemo(() => { try { return replayFromPgn(game.pgn); } catch { return []; } }, [game.pgn]);
  const sans = useMemo(() => steps.slice(1).map((s) => s.san!), [steps]);
  const ucis = useMemo(() => steps.slice(1).map((s) => s.uci!), [steps]);
  const last = Math.max(0, steps.length - 1);
  const [ply, setPly] = useState(0);
  const go = useCallback((p: number) => setPly(Math.max(0, Math.min(last, p))), [last]);
  usePlyKeys(ply, last, go, last > 0);
  const [flipped, flip] = useFlip(game.color);
  if (steps.length < 2) return <p className="mx-auto max-w-[700px] p-4 text-sm text-danger">Cette partie ne contient pas de coups lisibles.</p>;
  // noms : ceux du PGN (parties importées), sinon le pseudo du joueur et son adversaire
  const tag = (k: string) => { const v = new RegExp(`\\[${k} "([^"]*)"\\]`).exec(game.pgn)?.[1]; return v && v !== "?" ? v : null; };
  const elo = (k: string) => { const e = tag(k); return e && /^\d{3,4}$/.test(e) ? ` (${e})` : ""; };
  const mine = game.source ? (game.color === "w" ? tag("White") : tag("Black")) : null;
  const names = game.color === "w"
    ? { w: `${mine ?? me}${game.source ? elo("WhiteElo") : ""}`, b: game.opponent }
    : { w: game.opponent, b: `${mine ?? me}${game.source ? elo("BlackElo") : ""}` };
  const bottom: "w" | "b" = flipped;
  const result = resultOf(game);
  const label = game.outcome === "win" ? "victoire" : game.outcome === "loss" ? "défaite" : "nulle";
  const src = game.source === "lichess" ? "Lichess" : game.source === "pgn" ? "fichier PGN" : "ChessAurum";
  const row = (c: "w" | "b") => (
    <div className="panel flex items-center gap-2 px-3 py-1.5 max-lg:rounded-lg max-lg:px-2 max-lg:py-0.5">
      <span className={`size-3 shrink-0 rounded-sm border border-line ${c === "w" ? "bg-[#f3f3f3]" : "bg-[#222]"}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{names[c]}{c === game.color && <span className="ml-1 text-xs font-normal text-neon">(toi)</span>}</span>
      <span className="text-sm text-muted">{c === "w" ? result.split("-")[0] : result.split("-")[1]}</span>
    </div>
  );
  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-2 pb-6 sm:px-3 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start lg:px-6">
      <div className="flex min-w-0 flex-col gap-2 max-lg:sticky max-lg:top-0 max-lg:z-30 max-lg:-mx-2 max-lg:border-b max-lg:border-line max-lg:bg-ink max-lg:px-2 max-lg:pb-1.5 max-lg:pt-1 max-lg:shadow-lg">
        <p className="px-1 text-xs text-muted max-lg:hidden">
          <a href="/repertoire" className="text-neon hover:underline">← Répertoire</a> · {new Date(game.endedAt).toLocaleDateString("fr-FR")} · {src} · {label} avec les {game.color === "w" ? "Blancs" : "Noirs"}
        </p>
        <section data-board className="mx-auto flex w-full flex-col gap-1 max-w-[min(100%,44dvh)] sm:max-w-[min(100%,48dvh)] lg:max-w-[min(100%,max(320px,calc(100dvh_-_300px)))]">
          {row(bottom === "w" ? "b" : "w")}
          <GameBoard fen={steps[ply]!.fen} serverFen={steps[ply]!.fen} orientation={bottom} myColor={bottom} interactive={false} myTurn={false}
            lastMove={steps[ply]!.uci} premoves={[]} theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
            onMove={() => false} onCancelPremoves={() => {}} />
          {row(bottom)}
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1 max-lg:[&_button]:!px-0 max-lg:[&_button]:!py-1 max-lg:[&_button]:!text-sm"><MoveNav compact ply={ply} last={last} go={go} /></div>
            <a href={`/analyse?m=${ucis.slice(0, ply).join(",")}`} className="shrink-0 rounded-lg border border-neon/50 px-2 py-1 text-xs font-semibold text-neon">Analyser</a>
            <FlipButton onFlip={flip} />
          </div>
        </section>
      </div>
      <aside className="flex w-full min-w-0 flex-col gap-3">
        <GameReviewPanel cacheId={game.gameId} sans={sans} ucis={ucis} names={names} result={result} onGo={go} ply={ply} />
        <div className="panel flex flex-col gap-2 p-3">
          <MoveList moves={sans} active={ply - 1} onSelect={(p) => go(p + 1)} />
        </div>
      </aside>
    </div>
  );
}

function useFlip(color: "w" | "b"): ["w" | "b", () => void] {
  const [c, setC] = useState(color);
  return [c, () => setC((x) => (x === "w" ? "b" : "w"))];
}
