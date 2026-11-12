import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Toutes les parties d'un joueur, 30 par page : ?before=<date ISO> pour la page suivante. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pseudo = decodeURIComponent(id);
  if (pseudo.length < 1 || pseudo.length > 64 || /[\s/]/.test(pseudo)) return NextResponse.json({ error: "pseudo invalide" }, { status: 400 });
  const before = req.nextUrl.searchParams.get("before");
  const q = before && !Number.isNaN(Date.parse(before)) ? `?before=${encodeURIComponent(before)}` : "";
  return proxyToGameServer(req, `/account/players/${encodeURIComponent(pseudo)}/games${q}`);
}
