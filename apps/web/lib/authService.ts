import { signServiceToken } from "./betaSession";
import { gameServerBase } from "./gameServerApi";

/** Appel des routes /auth/* du serveur de jeu avec le jeton de service (jamais depuis le navigateur). */
export async function callAuth(path: string, body: unknown, key: string): Promise<{ status: number; data: Record<string, unknown> } | null> {
  try {
    const r = await fetch(`${gameServerBase()}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${signServiceToken(key)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return null;
  }
}
