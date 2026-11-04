import type { NextRequest } from "next/server";
import { proxyToGameServer } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Historique du joueur connecté : ?before=<date ISO> pour la page suivante. */
export async function GET(req: NextRequest) {
  const q = new URLSearchParams({ limit: "30" });
  const before = req.nextUrl.searchParams.get("before");
  if (before && !Number.isNaN(Date.parse(before))) q.set("before", before);
  return proxyToGameServer(req, `/account/games?${q}`);
}
