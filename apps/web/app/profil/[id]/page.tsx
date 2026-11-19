"use client";
import { useEffect, useState } from "react";
import type { GameHistoryItem } from "@chessarena/shared";
import { useParams } from "next/navigation";
import type { PlayerProfile } from "@chessarena/shared";
import { PageHeader } from "../../../components/PageHeader";
import { AccountSettings } from "../../../components/AccountSettings";
import { useMe } from "../../../hooks/useMe";
import { avatarFor, countryName, flagEmoji } from "../../../lib/profile";
import { relativeDate } from "../../../lib/replay";
import { pct, TC_LABEL, TC_ORDER } from "../../../lib/social";
import { fetchWake } from "../../../lib/wake";
import { SITE_NAME } from "../../../lib/site";

const OUTCOME = {
  win: { label: "Victoire", cls: "bg-win/15 text-win" },
  loss: { label: "Défaite", cls: "bg-danger/15 text-danger" },
  draw: { label: "Nulle", cls: "bg-surface-2 text-text" },
  aborted: { label: "Annulée", cls: "bg-surface-2 text-muted" },
} as const;

/** Profil d'un joueur : Elo par cadence, bilan, dernières parties, partie en cours. */
export default function ProfilePage() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const pseudo = decodeURIComponent(String(id ?? ""));
  const [p, setP] = useState<PlayerProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setP(null); setErr(null);
    fetchWake(`/api/players/${encodeURIComponent(pseudo)}`)
      .then(async (r) => {
        if (!r) return setErr("Le serveur ne répond pas pour le moment. Réessaie dans quelques minutes.");
        if (r.status === 404) return setErr("Ce joueur n'existe pas.");
        if (!r.ok) return setErr("Impossible de charger ce profil (le serveur se réveille peut-être : réessaie dans une minute).");
        setP((await r.json()) as PlayerProfile);
      })
      .catch(() => setErr("Impossible de charger ce profil."));
  }, [me, pseudo]);

  const mine = !!me && !!p && me.userId === p.userId;
  return (
    <main className="arena-app">
      <PageHeader title={p ? `Profil de ${p.userId}` : "Profil"} active={mine ? "/profil" : undefined} />
      <div className="mx-auto flex max-w-[900px] flex-col gap-3 px-2 pb-8 sm:px-3">
        {err && <p role="alert" className="panel p-4 text-sm text-danger">{err} <a href="/classement" className="text-neon underline">Voir le classement</a></p>}
        {!err && !p && <p className="panel p-4 text-sm text-muted">Chargement du profil… (si le serveur dormait, cela peut prendre jusqu'à une minute)</p>}
        {p && <Profile p={p} mine={mine} />}
        {p && mine && <AccountSettings />}
      </div>
    </main>
  );
}

function Profile({ p, mine }: { p: PlayerProfile; mine: boolean }) {
  const av = avatarFor(p.userId);
  const best = TC_ORDER.filter((tc) => p.ratings[tc].games > 0).sort((a, b) => p.ratings[b].games - p.ratings[a].games)[0];
  const t = p.totals;
  // toutes les parties : les 10 dernières d'abord, puis « Voir plus » (30 par page, jusqu'à la toute première)
  const [games, setGames] = useState<GameHistoryItem[]>(p.recent);
  const [more, setMore] = useState(t.games > p.recent.length);
  const [loading, setLoading] = useState(false);
  const loadMore = async () => {
    const lastAt = games.at(-1)?.endedAt;
    if (!lastAt) return;
    setLoading(true);
    const r = await fetch(`/api/players/${encodeURIComponent(p.userId)}/games?before=${encodeURIComponent(lastAt)}`, { cache: "no-store" }).catch(() => null);
    setLoading(false);
    if (!r?.ok) return;
    const page = ((await r.json()) as { games: GameHistoryItem[] }).games.filter((g) => g.outcome !== "aborted");
    setGames((g) => [...g, ...page.filter((x) => !g.some((y) => y.gameId === x.gameId))]);
    if (page.length === 0) setMore(false);
  };
  return (
    <>
      <section className="panel flex flex-wrap items-center gap-4 p-4">
        <div className="grid size-16 shrink-0 place-items-center rounded-xl text-xl font-bold text-white"
          style={{ background: `linear-gradient(135deg, hsl(${av.hue} 70% 46%), hsl(${(av.hue + 40) % 360} 75% 30%))` }} aria-hidden>{av.initials}</div>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold">
            {flagEmoji(p.flag ?? undefined) && <span title={countryName(p.flag ?? undefined) ?? undefined}>{flagEmoji(p.flag ?? undefined)}</span>}
            <span className="truncate">{p.userId}</span>
            {mine && <span className="text-sm font-normal text-muted">(toi)</span>}
          </h1>
          <p className="text-sm text-muted">
            {p.memberSince ? `Membre depuis ${new Date(p.memberSince).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}` : `Joueur ${SITE_NAME}`}
            {best ? ` · ${TC_LABEL[best]} ${p.ratings[best].rating}` : ""}
          </p>
        </div>
        {p.liveGameId && !mine && (
          <a href={`/direct/${p.liveGameId}`} className="neon-btn rounded-lg px-3 py-2 text-sm font-semibold">
            <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-danger align-middle" />Regarder sa partie
          </a>
        )}
        {p.liveGameId && mine && <a href="/play" className="neon-btn rounded-lg px-3 py-2 text-sm font-semibold">Reprendre ma partie</a>}
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Classement Elo par cadence">
        {TC_ORDER.map((tc) => {
          const r = p.ratings[tc];
          return (
            <a key={tc} href={`/classement?tc=${tc}`} className="panel p-3 hover:border-neon/50">
              <p className="text-[11px] uppercase tracking-wider text-muted">{TC_LABEL[tc]}</p>
              <p className={`tabular font-display text-2xl font-bold ${r.games ? "" : "text-muted"}`}>{r.rating}{r.games < 10 && r.games > 0 ? <span className="text-sm text-muted">?</span> : null}</p>
              <p className="text-xs text-muted">{r.games ? `${r.games} partie${r.games > 1 ? "s" : ""} · record ${r.peak}` : "aucune partie"}</p>
            </a>
          );
        })}
      </section>

      <section className="panel p-4">
        <h2 className="mb-2 text-sm font-semibold">Bilan · {t.games} partie{t.games > 1 ? "s" : ""}</h2>
        {t.games > 0 ? (
          <>
            <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="bg-win" style={{ width: `${pct(t.wins, t.games)}%` }} />
              <div className="bg-muted/50" style={{ width: `${pct(t.draws, t.games)}%` }} />
              <div className="bg-danger" style={{ width: `${pct(t.losses, t.games)}%` }} />
            </div>
            <p className="tabular mt-2 flex flex-wrap gap-x-4 text-sm">
              <span className="text-win">{t.wins} victoire{t.wins > 1 ? "s" : ""} ({pct(t.wins, t.games)} %)</span>
              <span>{t.draws} nulle{t.draws > 1 ? "s" : ""} ({pct(t.draws, t.games)} %)</span>
              <span className="text-danger">{t.losses} défaite{t.losses > 1 ? "s" : ""} ({pct(t.losses, t.games)} %)</span>
            </p>
          </>
        ) : <p className="text-sm text-muted">Pas encore de partie terminée.</p>}
      </section>

      <section className="panel p-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Parties <span className="font-normal text-muted">({games.length} affichée{games.length > 1 ? "s" : ""} sur {t.games})</span></h2>
          {mine && <a href="/api/history/export" className="text-xs text-neon hover:underline">⬇ Tout télécharger (PGN)</a>}
        </div>
        {games.length === 0 ? <p className="text-sm text-muted">Aucune partie.</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {games.map((g) => (
              <li key={g.gameId} className="flex items-center gap-3 py-2 text-sm">
                <span className={`w-20 shrink-0 rounded-md px-2 py-1 text-center text-xs font-semibold ${OUTCOME[g.outcome].cls}`}>{OUTCOME[g.outcome].label}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`inline-block size-2.5 rounded-sm border border-line ${g.color === "w" ? "bg-[#E7ECF3]" : "bg-[#1C2233]"}`} aria-label={g.color === "w" ? "Blancs" : "Noirs"} />
                    <span className="text-muted">contre</span>
                    <a href={`/profil/${encodeURIComponent(g.opponent)}`} className="truncate font-semibold hover:underline">{g.opponent}</a>
                    {g.opponentRating !== null && <span className="tabular text-xs text-muted">{g.opponentRating}</span>}
                  </span>
                  <span className="block text-xs text-muted">{TC_LABEL[g.timeControl]}{g.tournamentId ? " · tournoi" : ""} · {relativeDate(g.endedAt)}</span>
                </span>
                {g.ratingBefore !== null && g.ratingAfter !== null && (
                  <span className={`tabular shrink-0 text-xs font-semibold ${g.ratingAfter >= g.ratingBefore ? "text-win" : "text-danger"}`}>
                    {g.ratingAfter >= g.ratingBefore ? "+" : ""}{g.ratingAfter - g.ratingBefore}
                  </span>
                )}
                <a href={mine ? `/history?g=${g.gameId}` : `/partie/${g.gameId}`} className="shrink-0 text-xs text-neon hover:underline">{mine ? "Analyser" : "Voir la partie"}</a>
              </li>
            ))}
          </ul>
        )}
        {more && games.length > 0 && games.length < t.games && (
          <button type="button" disabled={loading} onClick={() => void loadMore()}
            className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-50">
            {loading ? "Chargement…" : "Voir plus de parties"}
          </button>
        )}
      </section>
    </>
  );
}
