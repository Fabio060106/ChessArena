import type { NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Clubs : les miens et tous les clubs ; création. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/clubs");
}
export async function POST(req: NextRequest) {
  const body = await req.text();
  if (body.length > 4096) return Response.json({ error: "trop long" }, { status: 413 });
  return proxyToGameServer(req, "/account/clubs", { method: "POST", body });
}
