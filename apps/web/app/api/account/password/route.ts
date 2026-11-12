import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, readSession, secret, signSession } from "../../../../lib/betaSession";
import { callAuth } from "../../../../lib/authService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Mot de passe actuel incorrect.",
  WEAK_PASSWORD: "Nouveau mot de passe : au moins 8 caractères, différent du pseudo.",
  BAD_RESET_CODE: "Code incorrect, expiré ou déjà utilisé. Demande un nouveau code à l'organisateur.",
  TOO_MANY_ATTEMPTS: "Trop d'essais. Réessaie dans un moment.",
  ACCOUNT_DISABLED: "Ce compte est fermé.",
};

/**
 * { action: "change", current, next }       — joueur connecté
 * { action: "reset", pseudo, code, password } — avec le code donné par l'organisateur ; connecte le joueur
 */
export async function POST(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant côté web" }, { status: 500 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
  const clientIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim().slice(0, 64);
  const fail = (r: { status: number; data: Record<string, unknown> } | null) => {
    const code = String(r?.data.error ?? "");
    return NextResponse.json({ error: MESSAGES[code] ?? "Le serveur ne répond pas : réessaie dans une minute.", code }, { status: r?.status && r.status >= 400 ? r.status : 502 });
  };

  if (b.action === "change") {
    const s = readSession(req.cookies.get(SESSION_COOKIE)?.value, key);
    if (!s) return NextResponse.json({ error: "non connecté" }, { status: 401 });
    const r = await callAuth("/auth/password/change", { userId: s.userId, current: str(b.current), next: str(b.next) }, key);
    return r?.status === 200 ? NextResponse.json({ ok: true }) : fail(r);
  }
  if (b.action === "reset") {
    const r = await callAuth("/auth/password/reset", { pseudo: str(b.pseudo, 40), code: str(b.code, 40), password: str(b.password), clientIp }, key);
    if (r?.status !== 200 || typeof r.data.userId !== "string") return fail(r);
    const sess = { userId: r.data.userId, ...(typeof r.data.flag === "string" ? { flag: r.data.flag } : {}) };
    const res = NextResponse.json(sess);
    res.cookies.set(SESSION_COOKIE, signSession(sess, key), {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_MAX_AGE_S,
    });
    return res;
  }
  return NextResponse.json({ error: "action inconnue" }, { status: 400 });
}
