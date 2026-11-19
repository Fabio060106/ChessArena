import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Ma liste d'amis, avec qui est en ligne ou en partie. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/friends");
}

/** Ajouter un ami par son pseudo. */
export async function POST(req: NextRequest) {
  const body = await req.text();
  if (body.length > 500) return NextResponse.json({ error: "trop volumineux" }, { status: 413 });
  return proxyToGameServer(req, "/account/friends", { method: "POST", body });
}
