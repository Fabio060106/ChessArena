"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { LinkChallengeView } from "@chessarena/shared";
import { PageHeader } from "../../../components/PageHeader";
import { useGameAuth, useMe } from "../../../hooks/useMe";
import { acceptLink } from "../../../lib/challenges";
import { TC_LABEL } from "../../../lib/social";

/** Page d'un lien de défi : « X te défie » → Accepter → la partie commence pour les deux. */
export default function LinkChallengePage() {
  const me = useMe();
  const getAuth = useGameAuth();
  const { code } = useParams<{ code: string }>();
  const [c, setC] = useState<LinkChallengeView | null | "gone">(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!me) return;
    fetch(`/api/challenges/${code}`, { cache: "no-store" })
      .then(async (r) => setC(r.ok ? ((await r.json()) as LinkChallengeView) : "gone"))
      .catch(() => setC("gone"));
  }, [me, code]);
  const mine = !!me && c !== null && c !== "gone" && c.from.toLowerCase() === me.userId.toLowerCase();

  const accept = async () => {
    setBusy(true); setErr(null);
    const e = await acceptLink(getAuth, code);
    if (e) { setErr(e); setBusy(false); return; }
    window.location.href = "/play"; // la partie est créée : la page de jeu la reprend
  };

  return (
    <main className="arena-app">
      <PageHeader title="Défi" />
      <div className="mx-auto flex max-w-md flex-col gap-3 px-3 pb-10 pt-4">
        {c === null ? <p className="panel p-4 text-sm text-muted">Chargement…</p>
          : c === "gone" ? (
            <div className="panel flex flex-col gap-3 p-5 text-center">
              <p className="text-4xl" aria-hidden>⌛</p>
              <h1 className="text-lg font-semibold">Ce défi n'est plus valable</h1>
              <p className="text-sm text-muted">Il a déjà été accepté, annulé, ou il a expiré (un lien dure 30 minutes).</p>
              <a href="/play" className="neon-btn rounded-lg px-3 py-2 font-semibold">Jouer une partie</a>
            </div>
          ) : (
            <div className="panel relative flex flex-col gap-3 overflow-hidden border-neon/50 p-5 text-center">
              <div className="pointer-events-none absolute -right-10 -top-10 size-36 rounded-full bg-neon/15 blur-2xl" />
              <p className="text-4xl" aria-hidden>⚔️</p>
              <h1 className="font-display text-2xl font-bold">
                {mine ? "Ton lien de défi" : <><a href={`/profil/${encodeURIComponent(c.from)}`} className="hover:underline">{c.from}</a> te défie</>}
              </h1>
              <p className="text-sm text-muted">{TC_LABEL[c.timeControl]} · partie classée, gratuite · couleurs tirées au sort</p>
              {mine ? (
                <p className="rounded-lg bg-surface-2 p-3 text-sm">Envoie ce lien à un ami : dès qu'il accepte, la partie commence pour vous deux. Garde le site ouvert.</p>
              ) : (
                <button type="button" disabled={busy} onClick={() => void accept()} className="neon-btn rounded-xl px-4 py-3 text-lg font-semibold disabled:opacity-60">
                  {busy ? "Lancement…" : "Accepter et jouer"}
                </button>
              )}
              {err && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-sm text-danger">{err}</p>}
            </div>
          )}
      </div>
    </main>
  );
}
