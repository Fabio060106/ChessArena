"use client";
import { useEffect, useState } from "react";
import type { TournamentCard, TournamentsPageResponse } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";
import { TournamentCardView as Card } from "../../components/TournamentCard";
import { filterTournaments, NO_FILTER, type TournamentFilter } from "../../lib/tournament";

const SYSTEMS: Array<[TournamentFilter["system"], string]> = [["all", "Tous"], ["swiss", "Suisse"], ["arena", "Arena"], ["ko", "Élimination"]];
const PACES: Array<[TournamentFilter["pace"], string]> = [["all", "Toutes cadences"], ["bullet", "Bullet"], ["blitz", "Blitz"], ["rapid", "Rapide"]];

/**
 * Vitrine des tournois : ceux qui vont commencer (on s'y inscrit en un clic), ceux qui se jouent
 * (classement en direct) et ceux qui viennent de finir (podium). Rafraîchie toutes les 20 s.
 */
export default function TournamentsPage() {
  const me = useMe();
  const [data, setData] = useState<TournamentsPageResponse | null | "error">(null);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<TournamentFilter>(NO_FILTER);
  const filtered = filter.system !== "all" || filter.pace !== "all" || filter.open;
  const f = (l: TournamentCard[]) => filterTournaments(l, filter);
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
              <div className="flex flex-col gap-1.5" role="group" aria-label="Filtrer les tournois">
                <Chips options={SYSTEMS} value={filter.system} onChange={(system) => setFilter((x) => ({ ...x, system }))} />
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chips options={PACES} value={filter.pace} onChange={(pace) => setFilter((x) => ({ ...x, pace }))} />
                  <button type="button" aria-pressed={filter.open} onClick={() => setFilter((x) => ({ ...x, open: !x.open }))}
                    className={chip(filter.open)}>Places libres</button>
                  {filtered && <button type="button" onClick={() => setFilter(NO_FILTER)} className="px-2 text-xs text-muted underline hover:text-text">effacer</button>}
                </div>
              </div>
              <Section title="En cours" empty={null} list={f(data.running)} now={now} />
              <Section title="À venir" list={f(data.upcoming)} now={now} limit={8}
                empty={filtered ? <>Aucun tournoi à venir avec ces filtres. <button type="button" className="text-neon underline" onClick={() => setFilter(NO_FILTER)}>Tout afficher</button></>
                  : <>Aucun tournoi ouvert pour l'instant. <a href="/play?onglet=tournoi" className="text-neon underline">Lance le premier</a> : ton club n'attend que ça.</>} />
              <Section title="Terminés récemment" empty={null} list={f(data.finished)} now={now} limit={6} />
            </>
          )}
      </div>
    </main>
  );
}

const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs font-semibold ${on ? "border-neon/60 bg-neon/10 text-neon" : "border-line text-muted hover:text-text"}`;

function Chips<T extends string>({ options, value, onChange }: { options: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={chip(value === v)}>{label}</button>
      ))}
    </div>
  );
}

function Section({ title, list, now, empty, limit }: { title: string; list: TournamentCard[]; now: number; empty: React.ReactNode; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!list.length && !empty) return null;
  const shown = limit && !all ? list.slice(0, limit) : list;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{title}{list.length ? ` (${list.length})` : ""}</h2>
      {list.length ? (
        <>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{shown.map((c) => <li key={c.id}><Card c={c} now={now} /></li>)}</ul>
          {shown.length < list.length && (
            <button type="button" onClick={() => setAll(true)} className="panel p-2.5 text-sm font-semibold text-neon hover:border-neon/50">
              Voir les {list.length - shown.length} autres
            </button>
          )}
        </>
      ) : <p className="panel p-4 text-sm text-muted">{empty}</p>}
    </section>
  );
}

