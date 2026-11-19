"use client";
import { useState } from "react";

/** Après la partie : signaler son adversaire à l'organisateur (soupçon d'aide d'un moteur). */
export function CheatReport({ opponent, onReport, resetKey }: { opponent: string; onReport: (reason: string) => Promise<boolean>; resetKey?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) { setKey(resetKey); setOpen(false); setReason(""); setState("idle"); }
  if (state === "done") return <p className="text-xs text-muted">Merci, l'organisateur va examiner la partie.</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-muted underline-offset-2 hover:text-danger hover:underline">
        ⚑ Signaler une triche de {opponent}
      </button>
    );
  }
  return (
    <form className="flex flex-col gap-1.5" onSubmit={async (e) => {
      e.preventDefault();
      setState("busy");
      setState((await onReport(reason)) ? "done" : "error");
    }}>
      <label className="text-xs text-muted" htmlFor="cheat-reason">Qu'est-ce qui t'a paru suspect ? (facultatif)</label>
      <textarea id="cheat-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2}
        placeholder="ex. : coups parfaits très rapides, a quitté l'écran avant chaque coup…"
        className="w-full rounded-lg border border-line bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-neon/60" />
      <div className="flex gap-2">
        <button type="submit" disabled={state === "busy"} className="rounded-lg border border-danger/60 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/10">Envoyer le signalement</button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:text-text">Annuler</button>
      </div>
      {state === "error" && <p role="alert" className="text-xs text-danger">Signalement impossible pour le moment. Réessaie dans une minute.</p>}
      <p className="text-[11px] text-muted/80">Le signalement est confidentiel. Rien n'est sanctionné sans analyse de la partie par l'organisateur.</p>
    </form>
  );
}
