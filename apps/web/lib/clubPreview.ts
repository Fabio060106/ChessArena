import { gameServerBase } from "./gameServerApi";

/** Aperçu public d'un club (lien partagé). */
export interface ClubPreview { name: string; description: string; memberCount: number; createdBy: string }

export async function fetchClubPreview(slug: string): Promise<ClubPreview | null> {
  if (!/^[a-z0-9-]{2,48}$/.test(slug)) return null;
  try {
    const r = await fetch(`${gameServerBase()}/public/clubs/${slug}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4_000) });
    return r.ok ? ((await r.json()) as ClubPreview) : null;
  } catch {
    return null;
  }
}
