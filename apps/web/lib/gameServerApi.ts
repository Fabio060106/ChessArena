import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSession, secret, signGameToken } from "./betaSession";

export function gameServerBase(): string {
  return (process.env.GAME_SERVER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
}

/**
 * Appel du serveur de jeu depuis le serveur Next (pas depuis le navigateur) : pas de CORS,
 * et le jeton de jeu est signé ici à partir de la session bêta du joueur.
 */
export async function proxyToGameServer(req: NextRequest, path: string, init?: { method: "PUT"; body: string }): Promise<NextResponse> {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant ou trop court côté web" }, { status: 500 });
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value, key);
  if (!session) return NextResponse.json({ error: "non connecté" }, { status: 401 });
  const base = gameServerBase();
  try {
    const r = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: {
        authorization: `Bearer ${signGameToken(session, key)}`,
        ...(init ? { "content-type": "application/json" } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000), // le serveur gratuit peut mettre ~1 min à se réveiller
    });
    return new NextResponse(await r.text(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "serveur de jeu injoignable" }, { status: 502 });
  }
}
