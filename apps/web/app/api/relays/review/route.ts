import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Analyse pédagogique calculée dans le navigateur : envoyée au serveur pour être partagée avec tous les spectateurs. */
export async function POST(req: NextRequest) {
  const body = await req.text();
  if (body.length > 420_000) return NextResponse.json({ error: "trop volumineux" }, { status: 413 });
  return proxyToGameServer(req, "/account/relay-review", { method: "POST", body });
}
