import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Détail d'une partie (PGN), réservé à ses deux joueurs. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "id invalide" }, { status: 400 });
  return proxyToGameServer(req, `/account/games/${id}`);
}
