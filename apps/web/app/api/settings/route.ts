import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Réglages du joueur connecté (apparence, son), partagés entre ses appareils. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/settings");
}

export async function PUT(req: NextRequest) {
  const body = await req.text();
  if (body.length > 5_000) return NextResponse.json({ error: "trop volumineux" }, { status: 413 });
  return proxyToGameServer(req, "/account/settings", { method: "PUT", body });
}
