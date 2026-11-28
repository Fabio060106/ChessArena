import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Page d'un club : membres, Elo, tournois du club. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{2,48}$/.test(slug)) return NextResponse.json({ error: "club inconnu" }, { status: 404 });
  return proxyToGameServer(req, `/account/clubs/${slug}`);
}
