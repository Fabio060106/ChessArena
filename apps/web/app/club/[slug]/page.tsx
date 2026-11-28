"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { ClubDetail, TournamentsPageResponse } from "@chessarena/shared";
import { PageHeader } from "../../../components/PageHeader";
import { TournamentCardView } from "../../../components/TournamentCard";
import { useMe } from "../../../hooks/useMe";

interface ClubPage { club: ClubDetail; member: boolean; tournaments: TournamentsPageResponse }

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
            const { club, member, tournaments } = data;
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
                    {member && club.createdBy !== me?.userId && <button type="button" disabled={busy} onClick={() => act("leave")} className="rounded-xl border border-line px-3 py-2.5 text-xs text-muted">Quitter</button>}
                  </div>
                  {member && <p className="mt-2 text-xs text-win">Tu es membre ✓</p>}
                  {msg && <p role="alert" className="mt-2 text-sm text-danger">{msg}</p>}
                </section>

                {has ? (
                  <section aria-label="Tournois du club" className="flex flex-col gap-2">
                    <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Tournois du club</h2>
                    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {[...tournaments.running, ...tournaments.upcoming, ...tournaments.finished].map((c) => <li key={c.id}><TournamentCardView c={c} now={Date.now()} /></li>)}
                    </ul>
                  </section>
                ) : member && <p className="panel p-4 text-sm text-muted">Pas encore de tournoi du club. <a href={`/play?onglet=tournoi&club=${club.slug}`} className="text-neon underline">Programme le premier</a> (par exemple chaque samedi à 20 h).</p>}

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
