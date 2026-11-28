"use client";
import { useEffect, useState } from "react";
import type { TournamentCard, TournamentsPageResponse } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";
import { TC_LABEL } from "../../lib/social";
import { formatMoney, remaining, startsIn, startsLabel, swissRoundsFor, weeklyLabel } from "../../lib/tournament";

/**
 * Vitrine des tournois : ceux qui vont commencer (on s'y inscrit en un clic), ceux qui se jouent
 * (classement en direct) et ceux qui viennent de finir (podium). Rafraîchie toutes les 20 s.
 */
export default function TournamentsPage() {
  const me = useMe();
  const [data, setData] = useState<TournamentsPageResponse | null | "error">(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const load = () => fetch("/api/tournaments", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(); const d = (await r.json()) as TournamentsPageResponse; if (alive) setData(d); })
      .catch(() => { if (alive) setData((x) => (x && x !== "error" ? x : "error")); });
    void load();
    const id = setInterval(() => { void load(); setNow(Date.now()); }, 20_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => { alive = false; clearInterval(id); clearInterval(tick); };
  }, [me]);

  return (
    <main className="arena-app">
      <PageHeader title="Tournois" active="/tournois" />
      <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-2 pb-10 sm:px-3">
        <section className="panel relative overflow-hidden p-4">
          <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-neon/15 blur-3xl" />
          <h1 className="font-display text-2xl font-bold">Tournois</h1>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">
            Suisse, Arena ou élimination directe : crée le tournoi de ton club en 30 secondes, programme-le à l'heure que tu veux et partage le lien.
            Tout le monde suit le classement en direct.
          </p>
          <a href="/play?onglet=tournoi" className="neon-btn mt-3 inline-block rounded-xl px-4 py-2.5 font-semibold">＋ Créer un tournoi</a>
        </section>

        {data === null ? <p className="panel p-4 text-sm text-muted">Chargement…</p>
          : data === "error" ? <p className="panel p-4 text-sm text-danger">Impossible de charger les tournois (le serveur se réveille peut-être : réessaie dans une minute).</p>
          : (
            <>
              <Section title="En cours" empty={null} list={data.running} now={now} />
              <Section title="À venir" list={data.upcoming} now={now}
                empty={<>Aucun tournoi ouvert pour l'instant. <a href="/play?onglet=tournoi" className="text-neon underline">Lance le premier</a> : ton club n'attend que ça.</>} />
              <Section title="Terminés récemment" empty={null} list={data.finished} now={now} />
            </>
          )}
      </div>
    </main>
  );
}

function Section({ title, list, now, empty }: { title: string; list: TournamentCard[]; now: number; empty: React.ReactNode }) {
  if (!list.length && !empty) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{title}{list.length ? ` (${list.length})` : ""}</h2>
      {list.length ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{list.map((c) => <li key={c.id}><Card c={c} now={now} /></li>)}</ul>
      ) : <p className="panel p-4 text-sm text-muted">{empty}</p>}
    </section>
  );
}

const SYSTEM = { swiss: "Suisse", arena: "Arena", ko: "Élimination directe" } as const;

function Card({ c, now }: { c: TournamentCard; now: number }) {
  const format = c.system === "arena" ? `Arena ${c.arenaMinutes} min` : c.system === "swiss" ? `Suisse ${c.totalRounds ?? swissRoundsFor(c.size)} rondes` : SYSTEM.ko;
  const live = c.status === "running";
  const fmtPts = (p: number | null) => (p === null ? "" : p % 1 ? `${Math.floor(p) || ""}½` : String(p));
  return (
    <a href={`/tournoi/${c.id}`} className={`panel flex h-full flex-col gap-2 p-3 transition-colors hover:border-neon/60 ${live ? "border-neon/40" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-base font-bold">{c.name ?? (c.createdBy ? `Tournoi de ${c.createdBy}` : "Tournoi")}</p>
          <p className="text-xs text-muted">{format} · {TC_LABEL[c.timeControl]} · {c.buyInCents > 0 ? `entrée ${formatMoney(c.buyInCents, c.currency)}` : "gratuit"}</p>
          {c.repeatWeekly && c.startsAt && <p className="text-xs text-neon">🔁 {weeklyLabel(c.startsAt)}</p>}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${live ? "bg-neon/15 text-neon" : c.status === "registering" ? "bg-gold/15 text-gold" : "bg-surface-2 text-muted"}`}>
          {live ? (c.system === "arena" && c.arenaEndsAt ? `● ⏱ ${remaining(c.arenaEndsAt, now)}` : c.system === "swiss" ? `● Ronde ${c.currentRound}/${c.totalRounds}` : "● En cours")
            : c.status === "registering" ? `${c.players}/${c.size}` : "Terminé"}
        </span>
      </div>
      {c.status === "registering" && (
        <p className="text-sm">{c.startsAt ? <><b className="text-gold">{startsLabel(c.startsAt)}</b> <span className="text-muted">({startsIn(c.startsAt, now)})</span></> : <span className="text-muted">Départ dès que c'est complet ou lancé par {c.createdBy ?? "l'organisateur"}</span>}</p>
      )}
      {c.leaders.length > 0 && (
        <ol className="flex flex-col gap-0.5 text-sm">
          {c.leaders.map((l, i) => (
            <li key={l.userId} className="flex items-center gap-2">
              <span className="w-5 text-muted">{c.status === "finished" ? ["🥇", "🥈", "🥉"][i] : i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{l.userId}</span>
              {l.points !== null && <span className="tabular text-xs font-semibold">{fmtPts(l.points)}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-auto text-xs text-muted">{c.status === "registering" ? `${c.players} inscrit${c.players > 1 ? "s" : ""}` : `${c.players} joueurs`}{c.createdBy ? ` · par ${c.createdBy}` : ""}</p>
    </a>
  );
}
