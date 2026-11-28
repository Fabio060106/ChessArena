"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { SEASON_PARTICIPATION, SEASON_POINTS, type ClubDetail, type ClubPost, type ClubSeason, type TournamentsPageResponse } from "@chessarena/shared";
import { WhatsAppButton } from "../../../components/WhatsAppButton";
import { PageHeader } from "../../../components/PageHeader";
import { TournamentCardView } from "../../../components/TournamentCard";
import { useMe } from "../../../hooks/useMe";

interface ClubPage { club: ClubDetail; member: boolean; tournaments: TournamentsPageResponse; season?: ClubSeason }

export default function Page() {
  return <Suspense><Club /></Suspense>;
}

/** Page d'un club : rejoindre, inviter, tournois du club, classement interne (blitz / rapide). */
function Club() {
  const me = useMe();
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<ClubPage | null | "none" | "error">(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tc, setTc] = useState<"blitz" | "rapid">("blitz");
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => {
    fetch(`/api/clubs/${slug}`, { cache: "no-store" })
      .then(async (r) => setData(r.ok ? ((await r.json()) as ClubPage) : r.status === 404 ? "none" : "error"))
      .catch(() => setData("error"));
  }, [slug]);
  useEffect(() => { if (me) load(); }, [me, load]);
  const act = async (action: "join" | "leave") => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/clubs/${slug}/${action}`, { method: "POST" }).catch(() => null);
    setBusy(false);
    if (r?.ok) { load(); return; }
    const code = r ? ((await r.json().catch(() => ({}))) as { error?: string }).error : undefined;
    setMsg(code === "OWNER_CANNOT_LEAVE" ? "Le fondateur ne peut pas quitter son club." : code === "TOO_MANY_CLUBS" ? "Tu es déjà membre de 20 clubs." : "Action impossible pour le moment.");
  };
  const link = typeof window === "undefined" ? `/club/${slug}` : `${window.location.origin}/club/${slug}`;
  return (
    <main className="arena-app">
      <PageHeader title="Club" active="/clubs" />
      <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-2 pb-10 sm:px-3">
        {data === null ? <p className="panel p-4 text-sm text-muted">Chargement…</p>
          : data === "none" ? <p className="panel p-4 text-sm text-danger">Ce club n'existe pas. <a href="/clubs" className="text-neon underline">Voir les clubs</a></p>
          : data === "error" ? <p className="panel p-4 text-sm text-danger">Impossible de charger le club (le serveur se réveille peut-être : réessaie dans une minute).</p>
          : (() => {
            const { club, member, tournaments, season } = data;
            const ranked = [...club.members].sort((a, b) => b[tc] - a[tc] || b.games - a.games);
            const has = tournaments.upcoming.length + tournaments.running.length + tournaments.finished.length > 0;
            return (
              <>
                <section className="panel relative overflow-hidden p-4">
                  <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-gold/15 blur-3xl" />
                  <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-gold">Club · {club.memberCount} membre{club.memberCount > 1 ? "s" : ""} · Elo moyen {club.avgBlitz ?? 1500}{club.battlesWon ? ` · ⚔️ ${club.battlesWon} victoire${club.battlesWon > 1 ? "s" : ""}` : ""}</p>
                  <h1 className="font-display text-2xl font-bold">{club.name}</h1>
                  {club.createdBy === me?.userId
                    ? <EditDescription slug={club.slug} initial={club.description} onSaved={load} />
                    : club.description && <p className="mt-1 max-w-[60ch] text-sm text-muted">{club.description}</p>}
                  <p className="mt-1 text-xs text-muted">Fondé par <a href={`/profil/${encodeURIComponent(club.createdBy)}`} className="hover:text-text">{club.createdBy}</a></p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!member && <button type="button" disabled={busy} onClick={() => act("join")} className="neon-btn rounded-xl px-4 py-2.5 font-semibold">{busy ? "…" : "Rejoindre le club"}</button>}
                    {member && <a href={`/play?onglet=tournoi&club=${club.slug}`} className="neon-btn rounded-xl px-4 py-2.5 font-semibold">＋ Tournoi du club</a>}
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
                      className="rounded-xl border border-neon/50 px-4 py-2.5 text-sm font-semibold text-neon">{copied ? "Lien copié ✓" : "Inviter : copier le lien"}</button>
                    <WhatsAppButton text={`Rejoins le club d'échecs « ${club.name} » sur ChessAurum : ${link}`} className="!rounded-xl !px-4 !py-2.5" />
                    {member && club.createdBy !== me?.userId && <button type="button" disabled={busy} onClick={() => act("leave")} className="rounded-xl border border-line px-3 py-2.5 text-xs text-muted">Quitter</button>}
                  </div>
                  {member && <p className="mt-2 text-xs text-win">Tu es membre ✓</p>}
                  {msg && <p role="alert" className="mt-2 text-sm text-danger">{msg}</p>}
                </section>

                {(club.posts.length > 0 || club.createdBy === me?.userId) && <Posts slug={club.slug} posts={club.posts} owner={club.createdBy === me?.userId} onChange={load} />}

                {has ? (
                  <section aria-label="Tournois du club" className="flex flex-col gap-2">
                    <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Tournois du club</h2>
                    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {[...tournaments.running, ...tournaments.upcoming, ...tournaments.finished].map((c) => <li key={c.id}><TournamentCardView c={c} now={Date.now()} /></li>)}
                    </ul>
                  </section>
                ) : member && <p className="panel p-4 text-sm text-muted">Pas encore de tournoi du club. <a href={`/play?onglet=tournoi&club=${club.slug}`} className="text-neon underline">Programme le premier</a> (par exemple chaque samedi à 20 h).</p>}

                {season && <Season season={season} me={me?.userId} />}

                <section aria-label="Classement du club" className="panel p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Classement du club</h2>
                    <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5 text-xs">
                      {(["blitz", "rapid"] as const).map((x) => (
                        <button key={x} type="button" aria-pressed={tc === x} onClick={() => setTc(x)} className={`rounded-md px-2.5 py-1 font-semibold ${tc === x ? "bg-surface text-text" : "text-muted"}`}>{x === "blitz" ? "Blitz" : "Rapide"}</button>
                      ))}
                    </div>
                  </div>
                  <ol className="flex flex-col">
                    {ranked.map((m, i) => (
                      <li key={m.userId}>
                        <a href={`/profil/${encodeURIComponent(m.userId)}`} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2 ${m.userId === me?.userId ? "bg-neon/10" : ""}`}>
                          <span className="tabular w-6 text-muted">{i === 0 ? "🏆" : i + 1}</span>
                          <span className="min-w-0 flex-1 truncate">{m.userId}{m.role === "owner" && <span className="ml-1.5 text-xs text-gold">fondateur</span>}</span>
                          <span className="tabular text-xs text-muted">{m.games} partie{m.games > 1 ? "s" : ""}</span>
                          <span className="tabular w-12 text-right font-semibold">{m[tc]}</span>
                        </a>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            );
          })()}
      </div>
    </main>
  );
}

/** Le fondateur modifie la description du club. */
function EditDescription({ slug, initial, onSaved }: { slug: string; initial: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  if (!editing) {
    return (
      <p className="mt-1 max-w-[60ch] text-sm text-muted">
        {initial || <span className="italic">Pas encore de description.</span>}{" "}
        <button type="button" onClick={() => setEditing(true)} className="text-xs text-neon hover:underline">modifier</button>
      </p>
    );
  }
  const save = async () => {
    setBusy(true); setErr(false);
    const r = await fetch(`/api/clubs/${slug}/describe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: text }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { setEditing(false); onSaved(); } else setErr(true);
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={280} rows={2} aria-label="Description du club"
        className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60" />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={save} className="neon-btn rounded-lg px-3 py-1.5 text-sm font-semibold">{busy ? "…" : "Enregistrer"}</button>
        <button type="button" onClick={() => { setEditing(false); setText(initial); }} className="text-sm text-muted">Annuler</button>
        {err && <span role="alert" className="text-sm text-danger">Enregistrement impossible (280 caractères au plus).</span>}
      </div>
    </div>
  );
}

/** Annonces du club : le fondateur publie (500 caractères), tout le monde lit. */
function Posts({ slug, posts, owner, onChange }: { slug: string; posts: ClubPost[]; owner: boolean; onChange: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const send = async (action: "post" | "unpost", payload: Record<string, string>) => {
    setBusy(true); setErr(false);
    const r = await fetch(`/api/clubs/${slug}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { if (action === "post") setText(""); onChange(); } else setErr(true);
  };
  return (
    <section aria-label="Annonces du club" className="panel flex flex-col gap-2 p-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">📣 Annonces</h2>
      {owner && (
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send("post", { body: text }); }} className="flex flex-col gap-1.5">
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={2} aria-label="Nouvelle annonce"
            placeholder="Tournoi blitz samedi 20 h, venez nombreux !" className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60" />
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || !text.trim()} className="neon-btn rounded-lg px-3 py-1.5 text-sm font-semibold">{busy ? "…" : "Publier"}</button>
            <span className="text-xs text-muted">{text.length}/500</span>
            {err && <span role="alert" className="text-sm text-danger">Publication impossible.</span>}
          </div>
        </form>
      )}
      {posts.length === 0 ? <p className="text-sm text-muted">Pas encore d'annonce.</p> : (
        <ul className="flex flex-col divide-y divide-line">
          {posts.map((p) => (
            <li key={p.id} className="py-2">
              <p className="whitespace-pre-line text-sm">{p.body}</p>
              <p className="mt-0.5 text-xs text-muted">
                {new Date(p.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })} · {p.author}
                {owner && <button type="button" disabled={busy} onClick={() => void send("unpost", { id: p.id })} className="ml-2 hover:text-danger">supprimer</button>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Classement du mois : points de place cumulés sur les tournois du club terminés ce mois-ci. */
function Season({ season, me }: { season: ClubSeason; me?: string }) {
  const [y, m] = season.month.split("-").map(Number);
  const label = `${MONTHS[(m ?? 1) - 1]} ${y}`;
  return (
    <section aria-label="Classement du mois" className="panel relative overflow-hidden p-3">
      <div className="pointer-events-none absolute -right-10 -top-10 size-32 rounded-full bg-gold/10 blur-2xl" />
      <h2 className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Classement du mois · {label}</h2>
      {season.rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Pas encore de tournoi du club terminé ce mois-ci : le premier tournoi lance la course au titre du mois.</p>
      ) : (
        <ol className="mt-2 flex flex-col">
          {season.rows.slice(0, 15).map((r, i) => (
            <li key={r.userId}>
              <a href={`/profil/${encodeURIComponent(r.userId)}`} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2 ${r.userId === me ? "bg-neon/10" : ""}`}>
                <span className="tabular w-6 text-muted">{["🥇", "🥈", "🥉"][i] ?? i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{r.userId}</span>
                <span className="tabular text-xs text-muted">{r.played} tournoi{r.played > 1 ? "s" : ""}{r.wins ? ` · ${r.wins} 🏆` : ""}</span>
                <span className="tabular w-12 text-right font-semibold">{r.points} pts</span>
              </a>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] text-muted">
        {season.tournaments} tournoi{season.tournaments > 1 ? "s" : ""} ce mois-ci. Barème : {SEASON_POINTS.map((p, i) => `${i + 1}${i ? "e" : "er"} ${p}`).join(", ")}, toute autre participation {SEASON_PARTICIPATION}.
      </p>
    </section>
  );
}
