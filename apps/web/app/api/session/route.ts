import { NextResponse, type NextRequest } from "next/server";
import {
  FLAG_RE, PSEUDO_RE, SESSION_COOKIE, SESSION_MAX_AGE_S, checkAccessCode, readSession, secret, signSession,
} from "../../../lib/betaSession";

export const dynamic = "force-dynamic";

/** Qui suis-je ? 200 { userId, flag } ou 401. */
export async function GET(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant ou trop court côté web" }, { status: 500 });
  const s = readSession(req.cookies.get(SESSION_COOKIE)?.value, key);
  return s ? NextResponse.json(s) : NextResponse.json({ error: "non connecté" }, { status: 401 });
}

/** Connexion bêta : { pseudo, code, flag? }. */
export async function POST(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant ou trop court côté web" }, { status: 500 });
  const body = (await req.json().catch(() => ({}))) as { pseudo?: unknown; code?: unknown; flag?: unknown };
  const pseudo = typeof body.pseudo === "string" ? body.pseudo.trim() : "";
  const code = typeof body.code === "string" ? body.code : "";
  const flag = typeof body.flag === "string" && FLAG_RE.test(body.flag) ? body.flag.toUpperCase() : undefined;
  if (!PSEUDO_RE.test(pseudo)) {
    return NextResponse.json({ error: "Pseudo : 3 à 20 caractères, lettres, chiffres, - ou _" }, { status: 400 });
  }
  if (!checkAccessCode(code)) {
    await new Promise((r) => setTimeout(r, 600)); // freine les essais en rafale
    return NextResponse.json({ error: "Code d'invitation invalide" }, { status: 403 });
  }
  const res = NextResponse.json({ userId: pseudo, ...(flag ? { flag } : {}) });
  res.cookies.set(SESSION_COOKIE, signSession({ userId: pseudo, flag }, key), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE_S,
  });
  return res;
}

/** Déconnexion. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
