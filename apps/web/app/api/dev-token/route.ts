import { NextResponse, type NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * DEV UNIQUEMENT — émet un JWT de jeu pour `?u=<id>`, afin de tester la chaîne
 * d'authentification complète sans activer DEV_AUTH sur le game-server.
 * Remplacé au Sprint 2 par une route qui lit la session NextAuth.
 */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  const secret = process.env.JWT_SECRET;
  if (!secret) return NextResponse.json({ error: "JWT_SECRET manquant côté web" }, { status: 500 });
  const u = req.nextUrl.searchParams.get("u") ?? "";
  if (!/^[\w-]{1,32}$/.test(u)) return NextResponse.json({ error: "identifiant invalide" }, { status: 400 });
  const token = jwt.sign({ sub: u, state: "active", kyc: false, country: "FR" }, secret, {
    algorithm: "HS256",
    expiresIn: "15m",
  });
  return NextResponse.json({ token });
}
