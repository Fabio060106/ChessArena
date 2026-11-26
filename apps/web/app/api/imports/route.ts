import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Parties importées (Lichess) et état de l'import en cours. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/imports");
}

/** Lance l'import des parties d'un compte Lichess (en arrière-plan sur le serveur). */
export async function POST(req: NextRequest) {
  const body = await req.text();
  if (body.length > 2000) return NextResponse.json({ error: "trop volumineux" }, { status: 413 });
  return proxyToGameServer(req, "/account/imports", { method: "POST", body });
}

/** Supprime toutes les parties importées. */
export async function DELETE(req: NextRequest) {
  return proxyToGameServer(req, "/account/imports", { method: "DELETE" });
}
