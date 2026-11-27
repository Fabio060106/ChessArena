import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Ajoute les parties d'un fichier PGN (envoyé par morceaux d'au plus 1,5 Mo par le navigateur). */
export async function POST(req: NextRequest) {
  const body = await req.text();
  if (body.length > 1_600_000) return NextResponse.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  return proxyToGameServer(req, "/account/imports/pgn", { method: "POST", body });
}
