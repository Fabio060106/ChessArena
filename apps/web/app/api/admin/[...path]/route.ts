import { NextResponse, type NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * Proxy du back-office vers l'API admin du game-server.
 * Le navigateur du modérateur ne détient jamais de jeton à privilèges : il est
 * fabriqué ici, côté serveur, pour chaque requête.
 *
 * DEV : identité « moderator-dev ». PRODUCTION : à brancher sur la session
 * NextAuth (rôle moderator vérifié en base) — refusé tant que ce n'est pas fait.
 */
const GAME_SERVER = process.env.GAME_SERVER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "http://localhost:4000";

function moderatorToken(): string | null {
  if (process.env.NODE_ENV === "production") return null; // TODO Sprint 4 : session NextAuth + rôle
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return jwt.sign({ sub: process.env.ADMIN_DEV_USER ?? "moderator-dev", role: "moderator" }, secret, { algorithm: "HS256", expiresIn: "2m" });
}

async function forward(req: NextRequest, path: string[]) {
  const token = moderatorToken();
  if (!token) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const target = `${GAME_SERVER}/admin/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const r = await fetch(target, {
    method: req.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: req.method === "POST" ? await req.text() : undefined,
    cache: "no-store",
  });
  return new NextResponse(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
