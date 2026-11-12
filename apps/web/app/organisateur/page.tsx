"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";

interface Report { id: string; reporter: string; reported: string; gameId: string; message: string; at: string }
const input = "w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2 text-text outline-none focus:border-neon/60";
const call = (action: string, extra: Record<string, unknown> = {}) =>
  fetch("/api/organizer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });

/** Espace organisateur : codes de réinitialisation de mot de passe, signalements du chat, joueurs privés de chat. */
export default function OrganizerPage() {
  const me = useMe();
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    if (!me) return;
    call("check").then(async (r) => setAdmin(r.ok && ((await r.json()) as { admin?: boolean }).admin === true), () => setAdmin(false));
  }, [me]);
  return (
    <main className="arena-app">
      <PageHeader title="Espace organisateur" />
      <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-2 pb-8 sm:px-3">
        {admin === null && <p className="panel p-4 text-sm text-muted">Chargement…</p>}
        {admin === false && <p className="panel p-4 text-sm text-danger">Cette page est réservée aux organisateurs.</p>}
        {admin && <><ResetCode /><Moderation /></>}
      </div>
    </main>
  );
}

function ResetCode() {
  const [target, setTarget] = useState("");
  const [res, setRes] = useState<{ ok: boolean; text: string; code?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setRes(null);
    const r = await call("reset-code", { target }).catch(() => null);
    const d = (await r?.json().catch(() => ({}))) as { code?: string; userId?: string; expiresAt?: string; error?: string } | undefined;
    if (r?.ok && d?.code) setRes({ ok: true, code: d.code, text: `Code pour ${d.userId}, valable jusqu'au ${new Date(d.expiresAt!).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}.` });
    else setRes({ ok: false, text: d?.error === "UNKNOWN_PLAYER" ? "Ce pseudo n'existe pas." : "Impossible de générer le code (serveur indisponible ?)." });
  };
  return (
    <section className="panel p-4">
      <h2 className="font-semibold">Mot de passe oublié</h2>
      <p className="mt-1 text-sm text-muted">Génère un code à usage unique et donne-le au joueur (de vive voix, par message). Il l'entre sur la page de connexion → « Mot de passe oublié ? ».</p>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="pseudo du joueur" required maxLength={20} className={input} />
        <button type="submit" className="neon-btn shrink-0 rounded-lg px-3 py-2 text-sm font-semibold">Générer un code</button>
      </form>
      {res && (
        <div role={res.ok ? "status" : "alert"} className={`mt-3 text-sm ${res.ok ? "" : "text-danger"}`}>
          {res.code && <p className="font-mono text-2xl font-bold tracking-widest text-neon">{res.code}</p>}
          <p className={res.ok ? "text-muted" : ""}>{res.text}</p>
        </div>
      )}
    </section>
  );
}

function Moderation() {
  const [data, setData] = useState<{ reports: Report[]; muted: string[] } | null>(null);
  const [target, setTarget] = useState("");
  const load = useCallback(async () => {
    const r = await call("reports").catch(() => null);
    if (r?.ok) setData((await r.json()) as { reports: Report[]; muted: string[] });
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mute = async (who: string, muted: boolean) => { await call("mute", { target: who, muted }); await load(); };
  const done = async (id: string) => { await call("report-done", { id }); await load(); };
  return (
    <section className="panel p-4">
      <h2 className="font-semibold">Chat : signalements</h2>
      {!data ? <p className="mt-2 text-sm text-muted">Chargement…</p> : data.reports.length === 0 ? <p className="mt-2 text-sm text-muted">Aucun signalement en attente.</p> : (
        <ul className="mt-2 flex flex-col divide-y divide-line">
          {data.reports.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <strong>{r.reported}</strong> : « {r.message} »
                <span className="block text-xs text-muted">signalé par {r.reporter} · {new Date(r.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
              </span>
              <button type="button" onClick={() => void mute(r.reported, true)} className="rounded-lg border border-danger/50 px-2 py-1 text-xs text-danger hover:bg-danger/10">Couper son chat</button>
              <button type="button" onClick={() => void done(r.id)} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-text">Classer</button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-4 text-sm font-semibold">Joueurs privés de chat</h3>
      {data && data.muted.length === 0 && <p className="text-sm text-muted">Aucun.</p>}
      <ul className="mt-1 flex flex-wrap gap-2">
        {data?.muted.map((u) => (
          <li key={u} className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-sm">
            {u}<button type="button" onClick={() => void mute(u, false)} className="text-xs text-neon hover:underline">rétablir</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); if (target) void mute(target, true).then(() => setTarget("")); }} className="mt-3 flex gap-2">
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="pseudo" maxLength={20} className={input} />
        <button type="submit" className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2">Couper le chat</button>
      </form>
    </section>
  );
}
