import type { LinkChallengeView } from "@chessarena/shared";
import { gameServerBase } from "./gameServerApi";

export const LINK_CODE = /^[a-hjkmnp-z2-9]{8}$/;

/** Défi par lien, lu côté serveur web (page et aperçu du lien partagé). */
export async function fetchLinkChallenge(code: string): Promise<LinkChallengeView | null> {
  if (!LINK_CODE.test(code)) return null;
  try {
    const r = await fetch(`${gameServerBase()}/public/challenges/${code}`, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    return r.ok ? ((await r.json()) as LinkChallengeView) : null;
  } catch {
    return null;
  }
}
