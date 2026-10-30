import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSession, secret, signGameToken } from "../../../lib/betaSession";

export const dynamic = "force-dynamic";

/** Jeton de jeu (15 min) pour le joueur connecté — demandé à chaque (re)connexion au serveur de jeu. */
export async function GET(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant ou trop court côté web" }, { status: 500 });
  const s = readSession(req.cookies.get(SESSION_COOKIE)?.value, key);
  if (!s) return NextResponse.json({ error: "non connecté" }, { status: 401 });
  return NextResponse.json({ token: signGameToken(s, key) }, { headers: { "Cache-Control": "no-store" } });
}
