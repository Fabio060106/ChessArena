"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const FLAGS = ["", "FR", "BE", "CH", "CA", "MA", "DZ", "TN", "SN", "CI", "DE", "ES", "IT", "PT", "GB", "US", "BR", "SG"];

const flagEmoji = (c: string) => (c ? String.fromCodePoint(...[...c].map((x) => 0x1f1e6 + x.charCodeAt(0) - 65)) : "—");

/** Entrée de la bêta fermée : pseudo + code d'invitation. */
/** Après connexion : la page demandée (ex. lien d'invitation /play?t=…), jamais un autre site. */
function nextPath(): string {
  if (typeof window === "undefined") return "/play";
  const n = new URLSearchParams(window.location.search).get("next") ?? "";
  return /^\/(play|history|repertoire)(\?[\w=&%-]*)?$/.test(n) ? n : "/play";
}

export default function Home() {
  const router = useRouter();
  const [pseudo, setPseudo] = useState("");
  const [code, setCode] = useState("");
  const [flag, setFlag] = useState("FR");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" }).then((r) => { if (r.ok) router.replace(nextPath()); }, () => {});
  }, [router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pseudo, code, flag }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) return router.replace(nextPath());
    setError(r ? ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Connexion refusée" : "Réseau indisponible");
  };

  return (
    <main className="arena-app grid place-items-center px-4">
      <form onSubmit={submit} className="panel flex w-full max-w-sm flex-col gap-4 p-6">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Chess<span className="text-neon">Arena</span></h1>
          <p className="mt-1 text-sm text-muted">Bêta fermée · parties en jetons, sans valeur</p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Pseudo</span>
          <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} required minLength={3} maxLength={20}
            pattern="[A-Za-z0-9_\-]{3,20}" autoComplete="username" placeholder="magnus_06"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-text outline-none focus:border-neon/60" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Drapeau affiché</span>
          <select value={flag} onChange={(e) => setFlag(e.target.value)}
            className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-text outline-none focus:border-neon/60">
            {FLAGS.map((f) => <option key={f} value={f}>{flagEmoji(f)} {f || "aucun"}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Code d'invitation</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} required type="password" autoComplete="off"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-text outline-none focus:border-neon/60" />
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy} className="neon-btn rounded-lg px-4 py-2.5 font-semibold">
          {busy ? "Connexion…" : "Entrer dans l'arène"}
        </button>
      </form>
    </main>
  );
}
