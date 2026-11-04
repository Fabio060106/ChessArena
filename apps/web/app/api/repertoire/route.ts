import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Parties + répertoire enregistré du joueur connecté. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/repertoire");
}

/** Enregistre le répertoire (coups choisis, exercices, analyses en cache). */
export async function PUT(req: NextRequest) {
  const body = await req.text();
  if (body.length > 1_100_000) return NextResponse.json({ error: "trop volumineux" }, { status: 413 });
  return proxyToGameServer(req, "/account/repertoire", { method: "PUT", body });
}
