"use client";
import type { RelaySummary } from "@chessarena/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../components/PageHeader";
import { useMe } from "../../hooks/useMe";
import type { GameHistoryDetail } from "@chessarena/shared";
import { reviewGame, type CheatMetrics } from "../../lib/fairplay";

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
        {admin && <><Relays /><FairPlay /><ResetCode /><Moderation /><ClubModeration /></>}
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

interface FairCase {
  gameId: string; userId: string; reasons: string[]; reports: string[]; focusLosses: number; timeCv: number | null; moves: number;
  at: string; white: string; black: string; result: string; timeControl: string;
}

/** Anti-triche : parties signalées (sorties d'onglet, temps métronomiques, signalements), revue avec Stockfish, décision. */
/** Retransmissions de tournois officiels (échiquiers électroniques DGT, via LiveChessCloud). */
function Relays() {
  const [list, setList] = useState<RelaySummary[] | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await call("relays").catch(() => null);
    if (r?.ok) setList(((await r.json()) as { relays: RelaySummary[] }).relays);
  }, []);
  // état de chaque retransmission (ronde, parties, erreurs) rafraîchi régulièrement
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5_000); return () => clearInterval(t); }, [load]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const r = await call("relay-add", { url: url.trim(), name: name.trim() }).catch(() => null);
    if (!r?.ok) {
      setMsg({ ok: false, text: r?.status === 400 ? "Lien non reconnu : il faut un lien view.livechesscloud.com/#… ou lichess.org/broadcast/…" : "Ajout impossible pour l'instant (serveur indisponible ?)." });
      return;
    }
    setMsg({ ok: true, text: "Retransmission ajoutée : elle apparaît dans « En direct » pour tous les joueurs." });
    setUrl(""); setName("");
    await load();
  };
  const remove = async (id: string, n: string) => {
    if (!window.confirm(`Arrêter la retransmission « ${n} » ?`)) return;
    await call("relay-remove", { id });
    await load();
  };
  return (
    <section className="panel p-4">
      <h2 className="font-semibold">Retransmissions de tournois</h2>
      <p className="mt-1 text-sm text-muted">
        Colle le lien du tournoi : de préférence LiveChessCloud (échiquiers électroniques DGT), du type <code className="text-xs">https://view.livechesscloud.com/#…</code>,
        sinon le lien de la retransmission Lichess, du type <code className="text-xs">https://lichess.org/broadcast/…</code> (lien du tournoi ou d'une ronde).
        Les coups arrivent en direct pour tous les spectateurs ; avec un lien de tournoi, la ronde en cours est suivie automatiquement.
      </p>
      <form onSubmit={add} className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">Lien du tournoi (LiveChessCloud ou Lichess)
          <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://view.livechesscloud.com/#… ou https://lichess.org/broadcast/…" spellCheck={false}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:w-56">Nom affiché
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Championnat du monde 2026"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="neon-btn rounded-lg px-4 py-2 text-sm font-semibold">Ajouter</button>
      </form>
      {msg && <p role="status" className={`mt-2 text-sm ${msg.ok ? "text-neon" : "text-danger"}`}>{msg.text}</p>}
      {list && list.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <a href={`/retransmissions/${r.id}`} className="flex-1 font-semibold hover:underline">{r.name}</a>
              <span className="text-xs text-muted">
                {r.error ? <span className="text-danger">{r.error}</span> : r.currentRound ? `${r.roundName ?? `ronde ${r.currentRound}`} · ${r.games} partie${r.games > 1 ? "s" : ""}${r.live ? " · en cours" : ""}` : "connexion à la source…"}
              </span>
              <button type="button" onClick={() => void remove(r.id, r.name)} className="text-xs text-muted underline hover:text-danger">Arrêter</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FairPlay() {
  const [data, setData] = useState<{ cases: FairCase[]; suspended: string[] } | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    const r = await call("fairplay").catch(() => null);
    if (r?.ok) { setData((await r.json()) as { cases: FairCase[]; suspended: string[] }); setErr(false); } else setErr(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const reinstate = async (u: string) => { await call("suspend", { target: u, suspended: false }); await load(); };
  return (
    <section className="panel p-4">
      <h2 className="font-semibold">Anti-triche</h2>
      <p className="mt-1 text-sm text-muted">
        Parties à revoir : un joueur est sorti plusieurs fois de l'onglet, a joué à un rythme métronomique, ou a été signalé par son adversaire.
        Ce ne sont que des indices : lance l'analyse Stockfish, puis décide. Rien n'est sanctionné automatiquement.
      </p>
      {err && <p role="alert" className="mt-2 text-sm text-danger">Impossible de charger la liste (serveur indisponible ?).</p>}
      {!data && !err && <p className="mt-2 text-sm text-muted">Chargement…</p>}
      {data && data.cases.length === 0 && <p className="mt-2 text-sm text-muted">Aucune partie à revoir. 👍</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {data?.cases.map((c) => <FairCaseRow key={`${c.gameId}:${c.userId}`} c={c} onDone={load} />)}
      </ul>
      {data && data.suspended.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Comptes suspendus</h3>
          <ul className="mt-1 flex flex-wrap gap-2">
            {data.suspended.map((u) => (
              <li key={u} className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-sm">
                {u}<button type="button" onClick={() => void reinstate(u)} className="text-xs text-neon hover:underline">réactiver</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FairCaseRow({ c, onDone }: { c: FairCase; onDone: () => Promise<void> }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [m, setM] = useState<CheatMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const color: "w" | "b" = c.userId === c.white ? "w" : "b";
  const analyse = async () => {
    setProgress(0);
    const r = await call("game", { gameId: c.gameId }).catch(() => null);
    if (!r?.ok) { setProgress(null); return; }
    const g = (await r.json()) as GameHistoryDetail;
    setM(await reviewGame(g.pgn, color, setProgress));
    setProgress(null);
  };
  const decide = async (verdict: "clean" | "cheat") => {
    if (verdict === "cheat" && !window.confirm(`Suspendre le compte de ${c.userId} ? Il ne pourra plus jouer (tu pourras le réactiver).`)) return;
    setBusy(true);
    await call("fairplay-review", { gameId: c.gameId, userId: c.userId, verdict });
    setBusy(false);
    await onDone();
  };
  const levelCls = m?.level === "suspect" ? "text-danger" : m?.level === "watch" ? "text-gold" : "text-win";
  return (
    <li className="rounded-lg border border-line p-3 text-sm">
      <p>
        <strong>{c.userId}</strong> <span className="text-muted">({color === "w" ? "Blancs" : "Noirs"})</span>
        <span className="text-muted"> · {c.white} – {c.black} · {c.result} · {new Date(c.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
      </p>
      <ul className="mt-1 list-disc pl-5 text-muted">
        {c.reasons.map((x) => <li key={x}>{x}</li>)}
        {c.reports.map((x) => <li key={x}>signalé par {x}</li>)}
      </ul>
      {m && (
        <div className="mt-2 rounded-lg bg-surface-2 p-2">
          <p className={`font-semibold ${levelCls}`}>{m.summary}</p>
          <p className="tabular text-xs text-muted">
            {m.counted} coups analysés (hors ouverture) · coups du moteur : {m.matchPct ?? "–"} % · perte moyenne : {m.acpl ?? "–"} centipions · précision : {m.accuracy ?? "–"} %
          </p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={`/partie/${c.gameId}`} target="_blank" rel="noreferrer" className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-surface-2">Voir la partie</a>
        <button type="button" disabled={progress !== null} onClick={() => void analyse()} className="rounded-lg border border-neon/50 px-2.5 py-1 text-xs font-semibold text-neon hover:bg-neon/10 disabled:opacity-60">
          {progress !== null ? `Analyse Stockfish… ${Math.round(progress * 100)} %` : m ? "Relancer l'analyse" : "Analyser avec Stockfish"}
        </button>
        <button type="button" disabled={busy} onClick={() => void decide("clean")} className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:text-text">Rien à signaler</button>
        <button type="button" disabled={busy} onClick={() => void decide("cheat")} className="rounded-lg border border-danger/60 px-2.5 py-1 text-xs text-danger hover:bg-danger/10">Triche : suspendre le compte</button>
      </div>
    </li>
  );
}

/** Clubs : supprimer un club au nom ou à la description inappropriés (adresse /club/…). */
function ClubModeration() {
  const [slug, setSlug] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirm) { setConfirm(true); return; }
    setRes(null);
    const r = await call("club-delete", { target: slug }).catch(() => null);
    setConfirm(false);
    setRes(r?.ok ? { ok: true, text: `Club « ${slug} » supprimé.` } : { ok: false, text: r?.status === 404 ? "Aucun club à cette adresse." : "Suppression impossible (serveur indisponible ?)." });
    if (r?.ok) setSlug("");
  };
  return (
    <section className="panel p-4">
      <h2 className="font-semibold">Clubs : modération</h2>
      <p className="mt-1 text-sm text-muted">Supprime un club au contenu inapproprié. Indique son adresse : la fin du lien, par exemple « les-fous-du-roi » pour /club/les-fous-du-roi. Les membres sont retirés ; c'est définitif.</p>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input value={slug} onChange={(e) => { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setConfirm(false); }} placeholder="adresse du club" required maxLength={48} className={input} />
        <button type="submit" className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${confirm ? "border border-danger bg-danger/15 text-danger" : "neon-btn"}`}>{confirm ? "Confirmer la suppression" : "Supprimer"}</button>
      </form>
      {res && <p role={res.ok ? "status" : "alert"} className={`mt-3 text-sm ${res.ok ? "text-muted" : "text-danger"}`}>{res.text}</p>}
    </section>
  );
}
