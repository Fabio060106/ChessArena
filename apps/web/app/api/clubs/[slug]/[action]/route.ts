import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Rejoindre ou quitter un club. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string; action: string }> }) {
  const { slug, action } = await ctx.params;
  if (!/^[a-z0-9-]{2,48}$/.test(slug) || (action !== "join" && action !== "leave" && action !== "describe")) return NextResponse.json({ error: "requête invalide" }, { status: 400 });
  const body = action === "describe" ? (await req.text()).slice(0, 4096) : "{}";
  return proxyToGameServer(req, `/account/clubs/${slug}/${action}`, { method: "POST", body });
}
