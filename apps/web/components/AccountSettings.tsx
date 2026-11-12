"use client";
import { useEffect, useState, type FormEvent } from "react";

const input = "w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2 text-text outline-none focus:border-neon/60";

/** Mon compte (sur mon profil) : changer son mot de passe ; accès à l'espace organisateur. */
export function AccountSettings() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/organizer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "check" }) })
      .then(async (r) => { if (r.ok) setAdmin(((await r.json()) as { admin?: boolean }).admin === true); }, () => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const r = await fetch("/api/account/password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "change", current, next }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) { setMsg({ ok: true, text: "Mot de passe changé." }); setCurrent(""); setNext(""); setOpen(false); return; }
    setMsg({ ok: false, text: ((await r?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Réseau indisponible." });
  };

  return (
    <section className="panel p-4">
      <h2 className="mb-2 text-sm font-semibold">Mon compte</h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2">
          🔑 Changer mon mot de passe
        </button>
        {admin && <a href="/organisateur" className="rounded-lg border border-neon/50 px-3 py-2 text-sm font-semibold text-neon hover:bg-neon/10">🛠 Espace organisateur</a>}
      </div>
      {open && (
        <form onSubmit={submit} className="mt-3 grid max-w-md gap-2">
          <label className="text-sm text-muted">Mot de passe actuel
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required className={input} />
          </label>
          <label className="text-sm text-muted">Nouveau mot de passe (8 caractères minimum)
            <input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} required className={input} />
          </label>
          <button type="submit" disabled={busy} className="neon-btn rounded-lg px-3 py-2 text-sm font-semibold">{busy ? "…" : "Enregistrer"}</button>
        </form>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? "text-win" : "text-danger"}`}>{msg.text}</p>}
    </section>
  );
}
