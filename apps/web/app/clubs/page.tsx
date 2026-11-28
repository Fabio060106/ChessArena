"use client";
import { useEffect, useState } from "react";
import type { ClubSummary, ClubsResponse } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";

const ERRORS: Record<string, string> = {
  BAD_NAME: "Le nom doit faire de 3 à 40 caractères.",
  BAD_DESCRIPTION: "La description fait 280 caractères au plus.",
  TOO_MANY_CLUBS: "Tu as déjà créé 2 clubs (ou tu es membre de 20 clubs).",
};

/** Clubs : les miens, tous les clubs (les plus grands d'abord), création d'un club. */
export default function ClubsPage() {
  const me = useMe();
  const [data, setData] = useState<ClubsResponse | null | "error">(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!me) return;
    fetch("/api/clubs", { cache: "no-store" })
      .then(async (r) => setData(r.ok ? ((await r.json()) as ClubsResponse) : "error"))
      .catch(() => setData("error"));
  }, [me]);
  return (
    <main className="arena-app">
      <PageHeader title="Clubs" active="/clubs" />
      <div className="mx-auto flex max-w-[900px] flex-col gap-4 px-2 pb-10 sm:px-3">
        <section className="panel relative overflow-hidden p-4">
          <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-gold/15 blur-3xl" />
          <h1 className="font-display text-2xl font-bold">Clubs</h1>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">
            Crée la page de ton club : classement interne, tournois du club, et un lien pour que tout le monde vous rejoigne.
          </p>
          {!creating && <button type="button" onClick={() => setCreating(true)} className="neon-btn mt-3 rounded-xl px-4 py-2.5 font-semibold">＋ Créer un club</button>}
          {creating && <CreateClub onCancel={() => setCreating(false)} />}
        </section>
        {data === null ? <p className="panel p-4 text-sm text-muted">Chargement…</p>
          : data === "error" ? <p className="panel p-4 text-sm text-danger">Impossible de charger les clubs (le serveur se réveille peut-être : réessaie dans une minute).</p>
          : (
            <>
              {data.mine.length > 0 && <List title="Mes clubs" list={data.mine} />}
              <List title="Classement des clubs" list={data.all} sortable empty="Aucun club pour l'instant : crée le premier !" />
            </>
          )}
      </div>
    </main>
  );
}

const SORTS = { members: "Membres", elo: "Elo moyen", battles: "Batailles gagnées" } as const;

function List({ title, list, empty, sortable }: { title: string; list: ClubSummary[]; empty?: string; sortable?: boolean }) {
  const [sort, setSort] = useState<keyof typeof SORTS>("members");
  const sorted = !sortable ? list : [...list].sort((a, b) =>
    sort === "elo" ? (b.avgBlitz ?? 0) - (a.avgBlitz ?? 0) || b.memberCount - a.memberCount
      : sort === "battles" ? (b.battlesWon ?? 0) - (a.battlesWon ?? 0) || b.memberCount - a.memberCount
        : b.memberCount - a.memberCount || (b.avgBlitz ?? 0) - (a.avgBlitz ?? 0));
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{title}</h2>
        {sortable && list.length > 1 && (
          <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5 text-xs" role="group" aria-label="Trier les clubs">
            {(Object.keys(SORTS) as Array<keyof typeof SORTS>).map((k) => (
              <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)} className={`rounded-md px-2 py-1 font-semibold ${sort === k ? "bg-surface text-text" : "text-muted"}`}>{SORTS[k]}</button>
            ))}
          </div>
        )}
      </div>
      {list.length ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {sorted.map((c, i) => (
            <li key={c.slug}>
              <a href={`/club/${c.slug}`} className="panel flex h-full flex-col gap-1 p-3 hover:border-neon/60">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-display text-base font-bold">{sortable && <span className="tabular mr-1.5 text-sm text-muted">{i + 1}.</span>}{c.name}</span>
                  <span className="tabular shrink-0 text-xs text-muted">{c.memberCount} membre{c.memberCount > 1 ? "s" : ""}</span>
                </span>
                {c.description && <span className="line-clamp-2 text-sm text-muted">{c.description}</span>}
                <span className="mt-auto text-xs text-muted">Elo moyen {c.avgBlitz ?? 1500}{c.battlesWon ? ` · ⚔️ ${c.battlesWon} bataille${c.battlesWon > 1 ? "s" : ""} gagnée${c.battlesWon > 1 ? "s" : ""}` : ""} · fondé par {c.createdBy}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : <p className="panel p-4 text-sm text-muted">{empty}</p>}
    </section>
  );
}

function CreateClub({ onCancel }: { onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/clubs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description }) }).catch(() => null);
    if (r?.ok) { const c = (await r.json()) as ClubSummary; window.location.href = `/club/${c.slug}`; return; }
    const code = r ? ((await r.json().catch(() => ({}))) as { error?: string }).error : undefined;
    setError((code && ERRORS[code]) ?? "Création impossible pour le moment.");
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Nom du club
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="Échiquier de Port-de-Bouc"
          className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Description (facultatif)
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={2} placeholder="Entraînement le mardi soir, tournoi blitz le samedi…"
          className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60" />
      </label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="neon-btn flex-1 rounded-lg px-3 py-2.5 font-semibold">{busy ? "Création…" : "Créer le club"}</button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-line px-3 py-2.5 text-sm text-muted">Annuler</button>
      </div>
    </form>
  );
}
