"use client";
import { useEffect, useState } from "react";
import type { TimeControlId } from "@chessarena/shared";
import { cancelLink, createLink, useChallenges } from "../lib/challenges";
import { TC_LABEL, TC_ORDER } from "../lib/social";

export const linkUrl = (code: string) => `${typeof window === "undefined" ? "" : window.location.origin}/defi/${code}`;

/**
 * « Joue contre moi » : un lien à envoyer (WhatsApp, SMS…) ; le premier qui l'ouvre et accepte joue contre toi,
 * même s'il n'a pas encore de compte. Valable 30 minutes ; la partie démarre automatiquement.
 */
export function LinkChallenge({ compact = false }: { compact?: boolean }) {
  const { link } = useChallenges();
  const [open, setOpen] = useState(false);
  const [tc, setTc] = useState<TimeControlId>("blitz_3_0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [link]);

  const make = async () => {
    setBusy(true); setErr(null);
    const r = await createLink(tc);
    setBusy(false);
    if ("error" in r) setErr(r.error);
  };
  const share = async (code: string) => {
    const url = linkUrl(code);
    const text = `Je te défie aux échecs (${TC_LABEL[link?.timeControl ?? tc]}) : ${url}`;
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try { await navigator.share({ title: "Défi aux échecs", text, url }); return; } catch { /* annulé : on copie */ }
    }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* rien */ }
  };

  if (link) {
    const left = Math.max(0, Math.round((link.expiresAt - now) / 60_000));
    return (
      <div className="panel flex flex-col gap-2 border-neon/40 p-3" aria-label="Lien de défi">
        <p className="text-sm font-semibold">🔗 Ton lien de défi · {TC_LABEL[link.timeControl]}</p>
        <p className="tabular truncate rounded-lg bg-surface-2 px-2.5 py-2 text-xs">{linkUrl(link.code)}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => void share(link.code)} className="neon-btn flex-1 rounded-lg px-3 py-2 text-sm font-semibold">{copied ? "Lien copié ✓" : "Envoyer le lien"}</button>
          <button type="button" onClick={cancelLink} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Annuler</button>
        </div>
        <p className="text-xs text-muted">En attente d'un adversaire · valable encore {left} min. La partie commence dès qu'il accepte : garde le site ouvert.</p>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className={`panel flex items-center gap-3 p-3 text-left hover:border-neon/50 ${compact ? "" : "w-full"}`}>
        <span className="text-xl" aria-hidden>🔗</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Défier un ami par lien</span>
          <span className="block text-xs text-muted">Envoie-le sur WhatsApp : il joue même sans compte</span>
        </span>
      </button>
    );
  }
  return (
    <div className="panel flex flex-col gap-2 p-3">
      <p className="text-sm font-semibold">🔗 Défier un ami par lien</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Cadence">
        {TC_ORDER.map((x) => (
          <button key={x} type="button" aria-pressed={tc === x} onClick={() => setTc(x)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${tc === x ? "border-neon/60 bg-neon/10 text-neon" : "border-line text-muted hover:text-text"}`}>{TC_LABEL[x]}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void make()} className="neon-btn flex-1 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60">{busy ? "Création…" : "Créer le lien"}</button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Fermer</button>
      </div>
      {err && <p role="alert" className="text-xs text-danger">{err}</p>}
    </div>
  );
}
