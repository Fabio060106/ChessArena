import type { NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Mon tournoi du moment (bandeau de rappel sur toutes les pages). */
export async function GET(req: NextRequest) {
  return proxyToGameServer(req, "/account/my-tournament");
}
