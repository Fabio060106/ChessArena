import { NextResponse } from "next/server";
import { fetchLinkChallenge } from "../../../../lib/linkPreview";

/** Défi par lien (public : celui qui défie et la cadence). */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const c = await fetchLinkChallenge(code);
  return c ? NextResponse.json(c, { headers: { "cache-control": "no-store" } }) : NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
}
