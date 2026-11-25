"use client";
import { useEffect, useState } from "react";
import type { LiveGameView, RelaySummary } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { getSocket } from "../../lib/socket";
import { useGameAuth, useMe } from "../../hooks/useMe";
import { flagEmoji } from "../../lib/profile";
import { TC_LABEL } from "../../lib/social";

/** Parties en cours, à regarder en direct. */
export default function LivePage() {
  const me = useMe();
  return (
    <main className="arena-app">
      <PageHeader title="En direct" active="/direct" />
      <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-2 pb-8 sm:px-3">
        {me ? <><RelayList /><LiveList me={me.userId} /></> : <p className="p-3 text-sm text-muted">Chargement…</p>}
      </div>
    </main>
  );
}

/** Grands tournois retransmis (échiquiers électroniques), ajoutés par l'organisateur. */
function RelayList() {
  const [list, setList] = useState<RelaySummary[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void fetch("/api/relays", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { relays: RelaySummary[] }).relays : null))
      .then((l) => { if (live && l) setList(l); })
      .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!list || list.length === 0) return null;
  return (
    <section aria-label="Grands tournois">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Grands tournois</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map((r) => (
          <li key={r.id}>
            <a href={`/retransmissions/${r.id}`} className="panel flex items-center gap-3 p-3 hover:border-neon/50">
              <span className="text-2xl" aria-hidden>🏆</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{r.name}</span>
                <span className="text-xs text-muted">
                  {r.currentRound ? `${r.roundName ?? `Ronde ${r.currentRound}`} · ${r.games} partie${r.games > 1 ? "s" : ""}` : "Bientôt"}
                </span>
              </span>
              {r.live && <span className="text-xs font-semibold text-danger"><span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle" />En direct</span>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LiveList({ me }: { me: string }) {
  const getAuth = useGameAuth();
  const [games, setGames] = useState<LiveGameView[] | null>(null);
  useEffect(() => {
    const socket = getSocket(getAuth);
    const load = () => { if (socket.connected) socket.emit("watch:list", (g) => setGames(g)); };
    socket.on("connect", load);
    load();
    const id = setInterval(load, 5_000);
    return () => { clearInterval(id); socket.off("connect", load); };
  }, [getAuth]);

  if (games === null) return <p className="panel p-4 text-sm text-muted">Recherche des parties en cours… (le serveur peut mettre une minute à se réveiller)</p>;
  if (games.length === 0) return <p className="panel p-4 text-sm text-muted">Aucune partie en cours pour l'instant. <a href="/play" className="text-neon underline">Lance-en une</a> !</p>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {games.map((g) => {
        const mine = g.white.userId === me || g.black.userId === me;
        return (
          <li key={g.gameId}>
            <a href={mine ? "/play" : `/direct/${g.gameId}`} className="panel flex flex-col gap-2 p-3 transition hover:border-neon/50">
              <span className="flex items-center justify-between text-xs text-muted">
                <span>{TC_LABEL[g.timeControl]}{g.tournamentId ? " · tournoi" : ""} · {Math.ceil(g.ply / 2)} coup{g.ply > 2 ? "s" : ""}</span>
                <span>👁 {g.spectators}</span>
              </span>
              {[g.white, g.black].map((p, i) => (
                <span key={p.userId} className="flex items-center gap-2">
                  <span className={`inline-block size-3 rounded-sm border border-line ${i === 0 ? "bg-[#E7ECF3]" : "bg-[#1C2233]"}`} />
                  {flagEmoji(p.flag) && <span>{flagEmoji(p.flag)}</span>}
                  <span className="truncate font-semibold">{p.userId}</span>
                  <span className="tabular text-sm text-muted">{p.rating}</span>
                </span>
              ))}
              <span className="text-sm font-semibold text-neon">{mine ? "C'est ta partie → reprendre" : "Regarder →"}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
