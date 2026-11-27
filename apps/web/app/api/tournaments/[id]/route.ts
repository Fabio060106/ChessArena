import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Page d'un tournoi : état en direct, ou dernier état enregistré (tournoi terminé). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "tournoi inconnu" }, { status: 404 });
  return proxyToGameServer(req, `/account/tournaments/${id}`);
}
