import { NextResponse, type NextRequest } from "next/server";
import { TIME_CONTROLS } from "@chessarena/shared";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Classement d'une cadence : ?tc=blitz_3_0 */
export async function GET(req: NextRequest) {
  const tc = req.nextUrl.searchParams.get("tc") ?? "blitz_3_0";
  if (!(tc in TIME_CONTROLS)) return NextResponse.json({ error: "cadence inconnue" }, { status: 400 });
  return proxyToGameServer(req, `/account/leaderboard?tc=${tc}`);
}
