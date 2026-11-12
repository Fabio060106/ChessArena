import type { NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Toutes les parties du joueur connecté, en un fichier PGN (ChessBase, Lichess, etc.). */
export async function GET(req: NextRequest) {
  const res = await proxyToGameServer(req, "/account/games/export");
  if (res.ok) {
    const day = new Date().toISOString().slice(0, 10);
    res.headers.set("content-disposition", `attachment; filename="chessarena-mes-parties-${day}.pgn"`);
  }
  return res;
}
