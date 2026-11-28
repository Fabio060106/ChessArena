import type { NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Page « Tournois » : à venir, en cours, terminés récemment. */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/tournaments");
}
