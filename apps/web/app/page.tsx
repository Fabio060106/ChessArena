"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

/** Entrée de la bêta fermée : pseudo + code d'invitation (BETA_ACCESS_CODE). */
export default function Home() {
  const router = useRouter();
  const [pseudo, setPseudo] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" }).then((r) => { if (r.ok) router.replace("/play"); }, () => {});
  }, [router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pseudo, code }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) return router.replace("/play");
    setError(r ? ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Connexion refusée" : "Réseau indisponible");
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-neutral-300 p-6 dark:border-neutral-700">
        <div>
          <h1 className="text-2xl font-bold">ChessArena</h1>
          <p className="mt-1 text-sm text-neutral-500">Bêta fermée · parties en jetons, sans valeur</p>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Pseudo
          <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} required minLength={3} maxLength={20}
            pattern="[A-Za-z0-9_\-]{3,20}" placeholder="magnus_06" autoComplete="username"
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Code d'invitation
          <input value={code} onChange={(e) => setCode(e.target.value)} required type="password" autoComplete="off"
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700" />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 p-2 font-semibold text-white disabled:opacity-50">
          {busy ? "Connexion…" : "Jouer"}
        </button>
      </form>
    </main>
  );
}
