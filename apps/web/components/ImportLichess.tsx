"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportsResponse } from "@chessarena/shared";

const SPEEDS = [["bullet", "Bullet"], ["blitz", "Blitz"], ["rapid", "Rapide"], ["classical", "Classique"]] as const;
const ERRORS: Record<string, string> = {
  BAD_USERNAME: "Ce pseudo Lichess n'est pas valide.",
  BAD_SPEEDS: "Choisis au moins une cadence.",
  IMPORT_RUNNING: "Un import est déjà en cours.",
  IMPORT_TOO_SOON: "Attends une minute avant de relancer un import.",
  NOT_FOUND: "Ce compte Lichess n'existe pas (ou ses parties ne sont pas publiques).",
  RATE_LIMITED: "Lichess limite les téléchargements : réessaie dans quelques minutes.",
  FAILED: "L'import a échoué. Réessaie plus tard.",
};

/**
 * Import des parties d'un compte Lichess : elles rejoignent le répertoire (arbre d'ouvertures, erreurs récurrentes,
 * exercices) et donnent les statistiques par ouverture.
 */
export function ImportLichess({ onImported }: { onImported: () => void }) {
  const [data, setData] = useState<ImportsResponse | null>(null);
  const [name, setName] = useState("");
  const [max, setMax] = useState(300);
  const [speeds, setSpeeds] = useState<string[]>(["blitz", "rapid"]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/imports", { cache: "no-store" });
      if (!r.ok) return null;
      const d = (await r.json()) as ImportsResponse;
      setData(d);
      if (d.accounts[0]) setName((n) => n || d.accounts[0]!);
      return d;
    } catch { return null; }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // pendant l'import : on suit l'avancement, puis on recharge le répertoire
  const running = data?.status.state === "running";
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        if (data?.status.state === "error") setError(ERRORS[data.status.error ?? "FAILED"] ?? ERRORS.FAILED!);
        else onImported();
      }
      return;
    }
    wasRunning.current = true;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [running, data?.status.state, data?.status.error, load, onImported]);

  const start = async () => {
    setError(null);
    const r = await fetch("/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name.trim(), max, speeds }) }).catch(() => null);
    if (!r) { setError("Serveur injoignable."); return; }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
      setError(ERRORS[j.code ?? j.error ?? ""] ?? ERRORS.FAILED!);
      return;
    }
    wasRunning.current = true;
    await load();
  };
  const remove = async () => {
    if (!window.confirm("Supprimer toutes les parties importées de Lichess ? (ton répertoire enregistré est conservé)")) return;
    await fetch("/api/imports", { method: "DELETE" }).catch(() => null);
    await load();
    onImported();
  };

  const st = data?.status;
  return (
    <section className="panel mb-3 p-3" aria-label="Importer mes parties Lichess">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-sm font-bold">Mes parties Lichess</h2>
        <p className="text-xs text-muted">
          {data?.count ? `${data.count} partie${data.count > 1 ? "s" : ""} importée${data.count > 1 ? "s" : ""} (${data.accounts.join(", ")}) · elles comptent dans ton répertoire` : "Importe tes parties pour construire ton répertoire à partir de ce que tu joues vraiment."}
        </p>
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-text" aria-expanded={open}>
          {data?.count ? "Mettre à jour" : "Importer"}
        </button>
      </div>
      {(open || running) && (
        <div className="mt-3 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Pseudo Lichess
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. LeBaronRouge" autoComplete="off" spellCheck={false}
                className="w-48 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-text" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Nombre de parties
              <select value={max} onChange={(e) => setMax(Number(e.target.value))} className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-sm text-text">
                {[100, 300, 500].map((n) => <option key={n} value={n}>{n} dernières</option>)}
              </select>
            </label>
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
              <legend className="mb-1 text-xs text-muted">Cadences</legend>
              {SPEEDS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={speeds.includes(k)} onChange={(e) => setSpeeds((s) => (e.target.checked ? [...s, k] : s.filter((x) => x !== k)))} />
                  {label}
                </label>
              ))}
            </fieldset>
            <button type="button" disabled={running || !name.trim() || !speeds.length} onClick={() => void start()} className="neon-btn rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40">
              {running ? "Import en cours…" : "Importer mes parties"}
            </button>
          </div>
          {running && <p role="status" className="text-xs text-muted">Lichess envoie les parties de {st?.account} (environ 20 par seconde)…</p>}
          {!running && st?.state === "done" && <p role="status" className="text-xs text-win">{st.found} partie{st.found > 1 ? "s" : ""} trouvée{st.found > 1 ? "s" : ""}, {st.added} nouvelle{st.added > 1 ? "s" : ""}.</p>}
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <p className="text-xs text-muted">Seules tes parties publiques sont lues, sans mot de passe. Variantes et parties depuis une position personnalisée sont ignorées.</p>
          {!!data?.openings.length && (
            <div>
              <h3 className="mb-1 text-xs font-semibold text-muted">Tes ouvertures les plus jouées sur Lichess</h3>
              <ul className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                {data.openings.slice(0, 10).map((o) => (
                  <li key={`${o.color}${o.name}`} className="flex items-center gap-2">
                    <span className={`inline-block size-2.5 shrink-0 rounded-sm border border-line ${o.color === "w" ? "bg-[#E7ECF3]" : "bg-[#1C2233]"}`} aria-label={o.color === "w" ? "avec les Blancs" : "avec les Noirs"} />
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <span className="tabular text-xs text-muted">{o.games} p. · {o.score} %</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!data?.count && !running && <button type="button" onClick={() => void remove()} className="self-start text-xs text-muted underline hover:text-danger">Supprimer les parties importées</button>}
        </div>
      )}
    </section>
  );
}
