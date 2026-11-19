"use client";
import { useEffect, useState } from "react";
import type { TimeControlId } from "@chessarena/shared";
import { sendChallenge } from "../lib/challenges";
import { TC_LABEL, TC_ORDER } from "../lib/social";

const KEY = "arena.challenge.tc";
function lastTc(): TimeControlId {
  try { const v = localStorage.getItem(KEY); if (v && (TC_ORDER as string[]).includes(v)) return v as TimeControlId; } catch { /* stockage indisponible */ }
  return "blitz_3_0";
}

/** « Défier » : choix de la cadence puis envoi du défi (le suivi s'affiche en bas de l'écran). */
export function ChallengeButton({ to, disabled, className = "" }: { to: string; disabled?: boolean; className?: string }) {
  const [tc, setTc] = useState<TimeControlId>(lastTc);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { localStorage.setItem(KEY, tc); } catch { /* best-effort */ }
    setErr(await sendChallenge(to, tc));
    setBusy(false);
  };
  return (
    <span className={`inline-flex flex-col gap-1 ${className}`}>
      <span className="inline-flex items-center gap-1">
        <select aria-label={`Cadence du défi à ${to}`} value={tc} onChange={(e) => setTc(e.target.value as TimeControlId)}
          className="rounded-lg border border-line bg-surface-2 px-1.5 py-1.5 text-xs">
          {TC_ORDER.map((id) => <option key={id} value={id}>{TC_LABEL[id]}</option>)}
        </select>
        <button type="button" onClick={go} disabled={busy || disabled}
          className="neon-btn whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">⚔️ Défier</button>
      </span>
      {err && <span role="alert" className="text-xs text-danger">{err}</span>}
    </span>
  );
}

/** « Ajouter en ami » sur un profil (indique si c'est déjà fait). */
export function AddFriendButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"unknown" | "no" | "yes" | "busy" | "error">("unknown");
  useEffect(() => {
    void fetch("/api/friends", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { friends: Array<{ userId: string }> }).friends : null))
      .then((list) => setState(list ? (list.some((f) => f.userId === userId) ? "yes" : "no") : "no"))
      .catch(() => setState("no"));
  }, [userId]);
  if (state === "yes") return <a href="/amis" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted hover:text-text">✓ Dans tes amis</a>;
  return (
    <button type="button" disabled={state === "busy" || state === "unknown"}
      onClick={async () => {
        setState("busy");
        const r = await fetch("/api/friends", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pseudo: userId }) }).catch(() => null);
        setState(r?.ok ? "yes" : "error");
      }}
      className="rounded-lg border border-line px-3 py-2 text-sm font-semibold hover:bg-surface-2 disabled:opacity-50">
      {state === "error" ? "Réessayer d'ajouter" : "+ Ajouter en ami"}
    </button>
  );
}
