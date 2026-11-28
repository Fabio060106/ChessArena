"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { LeaderboardEntry, LeaderboardResponse, TimeControlId } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";
import { countryName, flagEmoji } from "../../lib/profile";
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
  const [country, setCountry] = useState<boolean>(params.get("pays") !== null);
  const cc = country && me?.flag ? me.flag : null;
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setData(null); setErr(null);
    window.history.replaceState(null, "", `/classement?tc=${tc}${cc ? `&pays=${cc}` : ""}`);
    fetchWake(`/api/leaderboard?tc=${tc}${cc ? `&pays=${cc}` : ""}`)
      .then(async (r) => (r?.ok ? setData((await r.json()) as LeaderboardResponse) : setErr("Impossible de charger le classement (le serveur se réveille peut-être : réessaie dans une minute).")))
      .catch(() => setErr("Impossible de charger le classement."));
  }, [me, tc, cc]);

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
        {me?.flag && (
          <div className="flex gap-1.5" role="group" aria-label="Classement mondial ou par pays">
            {([[false, "🌍 Monde"], [true, `${flagEmoji(me.flag)} ${countryName(me.flag) ?? me.flag}`]] as const).map(([v, label]) => (
              <button key={String(v)} type="button" aria-pressed={country === v} onClick={() => setCountry(v)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${country === v ? "border-neon/60 bg-neon/10 text-neon" : "border-line text-muted hover:text-text"}`}>{label}</button>
            ))}
          </div>
        )}
        {err && <p role="alert" className="panel p-4 text-sm text-danger">{err}</p>}
        {!err && !data && <p className="panel p-4 text-sm text-muted">Chargement…</p>}
        {data && data.entries.length === 0 && <p className="panel p-4 text-sm text-muted">Personne{cc ? ` (${countryName(cc) ?? cc})` : ""} n'a encore joué de partie classée en {TC_LABEL[tc]}. <a href="/play" className="text-neon underline">Sois le premier</a> !</p>}
        {data && data.entries.length > 0 && (
          <div className="panel overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-muted">
                <tr><th className="w-10 py-2 pl-3 pr-1 text-left font-normal">#</th><th className="text-left font-normal">Joueur</th><th className="w-px whitespace-nowrap px-2 text-right font-normal">Elo</th><th className="hidden w-px whitespace-nowrap px-2 text-right font-normal sm:table-cell">Record</th><th className="w-px whitespace-nowrap px-3 text-right font-normal"><span className="sm:hidden">Part.</span><span className="hidden sm:inline">Parties</span></th></tr>
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
      <td className="tabular py-2 pl-3 pr-1 text-muted">{medal ?? e.rank}</td>
      <td className="max-w-0 py-2">
        <a href={`/profil/${encodeURIComponent(e.userId)}`} className="flex items-center gap-1.5 font-semibold hover:underline">
          {flagEmoji(e.flag ?? undefined) && <span>{flagEmoji(e.flag ?? undefined)}</span>}
          <span className="truncate">{e.userId}</span>
          {e.userId === me && <span className="text-xs font-normal text-muted">(toi)</span>}
        </a>
      </td>
      <td className="tabular whitespace-nowrap px-2 text-right font-display text-base font-bold">{e.rating}{e.games < 10 ? <span className="text-xs text-muted">?</span> : null}</td>
      <td className="tabular hidden px-2 text-right text-muted sm:table-cell">{e.peak}</td>
      <td className="tabular px-3 text-right text-muted">{e.games}</td>
    </tr>
  );
}
