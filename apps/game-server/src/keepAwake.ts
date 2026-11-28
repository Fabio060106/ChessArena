/**
 * Hébergement gratuit (Render) : le serveur s'endort après 15 min sans requête entrante. Endormi, il ne lance pas
 * les tournois à l'heure (Arena du soir, tournois de club programmés). Il se rend donc visite à lui-même,
 * par son adresse publique, toutes les 10 minutes.
 *
 * Actif seulement sur Render (RENDER_EXTERNAL_URL, fournie par Render) ; KEEP_AWAKE=0 pour le couper
 * (ex. si les 750 h gratuites par mois sont partagées avec un autre service).
 */
export function keepAwake(env: NodeJS.ProcessEnv = process.env, everyMs = 10 * 60_000, fetchFn: typeof fetch = fetch): (() => void) | null {
  const base = env.RENDER_EXTERNAL_URL;
  if (!base || env.KEEP_AWAKE === "0" || env.NODE_ENV === "test") return null;
  const url = `${base.replace(/\/+$/, "")}/health`;
  const id = setInterval(() => {
    void fetchFn(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => console.warn("[keep-awake] visite manquée", (e as Error).message));
  }, everyMs);
  id.unref?.();
  console.log(`[keep-awake] visite de ${url} toutes les ${Math.round(everyMs / 60_000)} min`);
  return () => clearInterval(id);
}
