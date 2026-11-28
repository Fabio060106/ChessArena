import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Clubs d'un joueur (profil). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pseudo = decodeURIComponent(id);
  if (pseudo.length < 1 || pseudo.length > 64 || /[\s/]/.test(pseudo)) return NextResponse.json({ error: "pseudo invalide" }, { status: 400 });
  return proxyToGameServer(req, `/account/players/${encodeURIComponent(pseudo)}/clubs`);
}
