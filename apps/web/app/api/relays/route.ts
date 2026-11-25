import type { NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Retransmissions de tournois officiels en cours. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/relays");
}
