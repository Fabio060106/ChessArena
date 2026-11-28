import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Toutes les parties d'un tournoi en un fichier PGN (ChessBase, Lichess…). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "tournoi inconnu" }, { status: 404 });
  const res = await proxyToGameServer(req, `/account/tournaments/${id}/pgn`);
  if (res.ok) res.headers.set("content-disposition", `attachment; filename="chessaurum-tournoi-${id.slice(0, 8)}.pgn"`);
  return res;
}
