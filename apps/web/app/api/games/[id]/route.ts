import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Partie terminée, consultable par tout joueur connecté (lien d'analyse partagé). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "partie inconnue" }, { status: 400 });
  return proxyToGameServer(req, `/account/games/${id}/public`);
}
