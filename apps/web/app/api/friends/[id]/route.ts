import { NextResponse, type NextRequest } from "next/server";
import { proxyToGameServer } from "../../../../lib/gameServerApi";

export const dynamic = "force-dynamic";

/** Retirer un ami de sa liste. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pseudo = decodeURIComponent(id);
  if (pseudo.length < 1 || pseudo.length > 64 || /[\s/]/.test(pseudo)) return NextResponse.json({ error: "pseudo invalide" }, { status: 400 });
  return proxyToGameServer(req, `/account/friends/${encodeURIComponent(pseudo)}`, { method: "DELETE" });
}
