"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { LeaderboardEntry, LeaderboardResponse, TimeControlId } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";
import { flagEmoji } from "../../lib/profile";
import { TC_LABEL, TC_ORDER } from "../../lib/social";
import { fetchWake } from "../../lib/wake";

export default function LeaderboardPage() {
  return <Suspense><Leaderboard /></Suspense>;
}

/** Classement Elo par cadence (joueurs ayant au moins une partie classée). */
function Leaderboard() {
  const me = useMe();
  const params = useSearchParams();
  const initial = params.get("tc");
  const [tc, setTc] = useState<TimeControlId>(initial && (TC_ORDER as string[]).includes(initial) ? (initial as TimeControlId) : "blitz_3_0");
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setData(null); setErr(null);
    window.history.replaceState(null, "", `/classement?tc=${tc}`);
    fetchWake(`/api/leaderboard?tc=${tc}`)
      .then(async (r) => (r?.ok ? setData((await r.json()) as LeaderboardResponse) : setErr("Impossible de charger le classement (le serveur se réveille peut-être : réessaie dans une minute).")))
      .catch(() => setErr("Impossible de charger le classement."));
  }, [me, tc]);

  const meInTop = !!data?.me && data.entries.some((e) => e.userId === data.me!.userId);
  return (
    <main className="arena-app">
      <PageHeader title="Classement" active="/classement" />
      <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-2 pb-8 sm:px-3">
        <div className="flex gap-1 overflow-x-auto rounded-lg bg-surface-2 p-0.5" role="tablist" aria-label="Cadence">
          {TC_ORDER.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tc === t} onClick={() => setTc(t)}
              className={`flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold ${tc === t ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
              {TC_LABEL[t]}
            </button>
          ))}
        </div>
        {err && <p role="alert" className="panel p-4 text-sm text-danger">{err}</p>}
        {!err && !data && <p className="panel p-4 text-sm text-muted">Chargement…</p>}
        {data && data.entries.length === 0 && <p className="panel p-4 text-sm text-muted">Personne n'a encore joué de partie classée en {TC_LABEL[tc]}. <a href="/play" className="text-neon underline">Sois le premier</a> !</p>}
        {data && data.entries.length > 0 && (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-muted">
                <tr><th className="w-12 px-3 py-2 text-left font-normal">#</th><th className="text-left font-normal">Joueur</th><th className="px-2 text-right font-normal">Elo</th><th className="hidden px-2 text-right font-normal sm:table-cell">Record</th><th className="px-3 text-right font-normal">Parties</th></tr>
              </thead>
              <tbody>
                {data.entries.map((e) => <Row key={e.userId} e={e} me={me?.userId} />)}
                {data.me && !meInTop && (
                  <>
                    <tr><td colSpan={5} className="px-3 py-1 text-center text-muted">…</td></tr>
                    <Row e={data.me} me={me?.userId} />
                  </>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-1 text-[11px] text-muted/70">Elo calculé partie après partie (parties classées uniquement). « ? » : classement provisoire, moins de 10 parties.</p>
      </div>
    </main>
  );
}

function Row({ e, me }: { e: LeaderboardEntry; me?: string }) {
  const medal = e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : null;
  return (
    <tr className={`border-t border-line ${e.userId === me ? "bg-neon/10" : ""}`}>
      <td className="tabular px-3 py-2 text-muted">{medal ?? e.rank}</td>
      <td className="max-w-0 py-2">
        <a href={`/profil/${encodeURIComponent(e.userId)}`} className="flex items-center gap-1.5 font-semibold hover:underline">
          {flagEmoji(e.flag ?? undefined) && <span>{flagEmoji(e.flag ?? undefined)}</span>}
          <span className="truncate">{e.userId}</span>
          {e.userId === me && <span className="text-xs font-normal text-muted">(toi)</span>}
        </a>
      </td>
      <td className="tabular px-2 text-right font-display text-base font-bold">{e.rating}{e.games < 10 ? <span className="text-xs text-muted">?</span> : null}</td>
      <td className="tabular hidden px-2 text-right text-muted sm:table-cell">{e.peak}</td>
      <td className="tabular px-3 text-right text-muted">{e.games}</td>
    </tr>
  );
}
