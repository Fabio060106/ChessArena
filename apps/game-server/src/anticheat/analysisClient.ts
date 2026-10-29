import type { AnalysisRequest } from "@chessarena/shared";

/**
 * MVP : POST HTTP vers le microservice d'analyse, avec retries.
 * Sprint 4 : remplacer par une file durable (BullMQ sur Redis) pour ne perdre
 * aucune partie si le service d'analyse est indisponible.
 */
export function makeAnalysisClient(baseUrl: string) {
  return async function submit(req: AnalysisRequest): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${baseUrl}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        });
        if (r.status === 202 || r.ok) return;
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
    throw lastErr;
  };
}
