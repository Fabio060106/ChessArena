import { NextResponse } from "next/server";
import { gameServerBase } from "../../../lib/gameServerApi";

/** Vitrine publique de la page d'accueil (sans connexion). */
export async function GET() {
  try {
    const r = await fetch(`${gameServerBase()}/public/showcase`, { next: { revalidate: 30 }, signal: AbortSignal.timeout(4_000) });
    if (!r.ok) return NextResponse.json({ nextOfficial: null, playing: 0, online: 0 });
    return NextResponse.json(await r.json(), { headers: { "cache-control": "public, max-age=30" } });
  } catch {
    return NextResponse.json({ nextOfficial: null, playing: 0, online: 0 });
  }
}
