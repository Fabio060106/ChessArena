/**
 * Le serveur gratuit s'endort après 15 min sans visite et met jusqu'à ~1 min à se réveiller.
 * Plutôt que d'afficher une erreur, on réessaie pendant ce temps (et on prévient l'utilisateur).
 */
export async function fetchWake(url: string, opts: { onWaiting?: (waiting: boolean) => void; maxMs?: number; init?: RequestInit } = {}): Promise<Response | null> {
  const end = Date.now() + (opts.maxMs ?? 120_000);
  let waiting = false;
  for (;;) {
    const r = await fetch(url, { cache: "no-store", ...opts.init }).catch(() => null);
    // réponse définitive : succès ou erreur « client » (non connecté, introuvable…)
    if (r && (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429))) {
      if (waiting) opts.onWaiting?.(false);
      return r;
    }
    if (Date.now() > end) { if (waiting) opts.onWaiting?.(false); return r; }
    if (!waiting) { waiting = true; opts.onWaiting?.(true); }
    await new Promise((res) => setTimeout(res, 4_000));
  }
}

/** Copie locale (cet appareil) : l'historique reste consultable même quand le serveur dort. */
export const localCache = {
  get<T>(key: string): T | null {
    try { const v = localStorage.getItem(`arena.cache.${key}`); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(`arena.cache.${key}`, JSON.stringify(value)); } catch { /* stockage plein ou indisponible : sans gravité */ }
  },
};
