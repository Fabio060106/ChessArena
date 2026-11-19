"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { FriendView } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { ChallengeButton } from "../../components/ChallengeButton";
import { useMe } from "../../hooks/useMe";
import { flagEmoji } from "../../lib/profile";

const ADD_ERRORS: Record<number, string> = {
  404: "Aucun joueur avec ce pseudo.",
  400: "Ce pseudo n'est pas valable (ce ne peut pas être le tien).",
  409: "Ta liste est pleine (200 amis maximum).",
};

/** Amis : ajout par pseudo, qui est en ligne, défi direct, partie à regarder. */
export default function FriendsPage() {
  const me = useMe();
  const [friends, setFriends] = useState<FriendView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pseudo, setPseudo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/friends", { cache: "no-store" }).catch(() => null);
    if (!r?.ok) { setError("Liste indisponible pour l'instant (le serveur se réveille peut-être). Nouvel essai dans quelques secondes…"); return; }
    setError(null);
    setFriends(((await r.json()) as { friends: FriendView[] }).friends);
  }, []);
  useEffect(() => {
    if (!me) return;
    void load();
    const t = setInterval(() => void load(), 20_000); // présence à jour
    return () => clearInterval(t);
  }, [me, load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const p = pseudo.trim();
    if (!p) return;
    setMsg(null);
    const r = await fetch("/api/friends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pseudo: p }) }).catch(() => null);
    if (!r?.ok) { setMsg({ ok: false, text: (r && ADD_ERRORS[r.status]) ?? "Ajout impossible pour l'instant, réessaie." }); return; }
    const { userId } = (await r.json()) as { userId: string };
    setMsg({ ok: true, text: `${userId} est dans tes amis.` });
    setPseudo("");
    void load();
  };
  const remove = async (id: string) => {
    if (!window.confirm(`Retirer ${id} de tes amis ?`)) return;
    await fetch(`/api/friends/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    void load();
  };

  const sorted = friends ? [...friends].sort((a, b) => Number(b.online) - Number(a.online)) : null;
  const onlineCount = friends?.filter((f) => f.online).length ?? 0;
  return (
    <main className="arena-app">
      <PageHeader title="Amis" active="/amis" />
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-2 pb-8 sm:px-3">
        <form onSubmit={add} className="panel flex flex-wrap items-end gap-2 p-4">
          <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-sm">
            Ajouter un ami (pseudo)
            <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} maxLength={40} autoComplete="off" spellCheck={false}
              placeholder="ex. Raphael" className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-base" />
          </label>
          <button type="submit" className="neon-btn rounded-lg px-4 py-2 text-sm font-semibold">Ajouter</button>
          {msg && <p role="status" className={`w-full text-sm ${msg.ok ? "text-neon" : "text-danger"}`}>{msg.text}</p>}
        </form>

        <section className="panel p-4" aria-label="Mes amis">
          <h1 className="mb-1 font-display text-lg font-bold">Mes amis{friends ? ` (${friends.length})` : ""}</h1>
          <p className="mb-3 text-xs text-muted">
            {friends && friends.length > 0 ? `${onlineCount} en ligne. ` : ""}On ne peut défier qu'un ami connecté sur le site. Il a 60 s pour accepter ; la partie est classée, sans mise.
          </p>
          {error && <p className="text-sm text-gold">{error}</p>}
          {!sorted && !error && <p className="text-sm text-muted">Chargement…</p>}
          {sorted && sorted.length === 0 && <p className="text-sm text-muted">Aucun ami pour l'instant : ajoute le pseudo d'un joueur ci-dessus, ou depuis son profil.</p>}
          {sorted && sorted.length > 0 && (
            <ul className="flex flex-col divide-y divide-line">
              {sorted.map((f) => (
                <li key={f.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <span className={`size-2.5 shrink-0 rounded-full ${f.liveGameId ? "bg-gold" : f.online ? "bg-neon" : "bg-line"}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <a href={`/profil/${encodeURIComponent(f.userId)}`} className="font-semibold hover:underline">
                      {flagEmoji(f.flag ?? undefined) && <span className="mr-1">{flagEmoji(f.flag ?? undefined)}</span>}{f.userId}
                    </a>
                    <span className="block text-xs text-muted">{f.liveGameId ? "en partie" : f.online ? "en ligne" : "hors ligne"} · Blitz {f.rating}</span>
                  </span>
                  {f.liveGameId
                    ? <a href={`/direct/${f.liveGameId}`} className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-semibold hover:text-text">👁 Regarder</a>
                    : f.online ? <ChallengeButton to={f.userId} /> : null}
                  <button type="button" onClick={() => void remove(f.userId)} className="text-xs text-muted underline hover:text-text" aria-label={`Retirer ${f.userId} de mes amis`}>Retirer</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
