import { NextResponse, type NextRequest } from "next/server";
import {
  FLAG_RE, SESSION_COOKIE, SESSION_MAX_AGE_S, checkAccessCode, readSession, secret, signServiceToken, signSession,
} from "../../../lib/betaSession";
import { gameServerBase } from "../../../lib/gameServerApi";

export const dynamic = "force-dynamic";
/** le serveur de jeu gratuit peut mettre ~1 min à se réveiller */
export const maxDuration = 60;

const MESSAGES: Record<string, string> = {
  BAD_PSEUDO: "Pseudo : 3 à 20 caractères, lettres, chiffres, - ou _",
  RESERVED_PSEUDO: "Ce pseudo est réservé.",
  WEAK_PASSWORD: "Mot de passe : au moins 8 caractères, différent du pseudo.",
  BAD_EMAIL: "Adresse e-mail invalide.",
  CONSENT_REQUIRED: "Coche les deux cases pour créer ton compte.",
  PSEUDO_TAKEN: "Ce pseudo est déjà pris.",
  EMAIL_TAKEN: "Cette adresse e-mail est déjà utilisée.",
  CLAIM_CODE_REQUIRED: "Ce pseudo a été utilisé pendant la bêta : entre le code d'invitation pour le récupérer avec ton historique.",
  INVALID_CREDENTIALS: "Pseudo ou mot de passe incorrect.",
  NO_PASSWORD_YET: "Ce pseudo vient de la bêta et n'a pas encore de mot de passe : choisis « Créer un compte » pour le récupérer.",
  TOO_MANY_ATTEMPTS: "Trop d'essais. Réessaie dans quelques minutes.",
  ACCOUNT_DISABLED: "Ce compte est fermé.",
};

/** Qui suis-je ? 200 { userId, flag } ou 401. */
export async function GET(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant ou trop court côté web" }, { status: 500 });
  const s = readSession(req.cookies.get(SESSION_COOKIE)?.value, key);
  return s ? NextResponse.json(s) : NextResponse.json({ error: "non connecté" }, { status: 401 });
}

/**
 * Inscription { mode: "signup", pseudo, password, flag?, email?, adult, terms, code? }
 * ou connexion { mode: "login", pseudo, password }.
 */
export async function POST(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant ou trop court côté web" }, { status: 500 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
  const signup = b.mode === "signup";
  const flag = FLAG_RE.test(str(b.flag)) ? str(b.flag).toUpperCase() : "";
  const clientIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim().slice(0, 64);
  const payload = signup
    ? {
        pseudo: str(b.pseudo, 40), password: str(b.password, 200), flag, email: str(b.email, 254),
        adult: b.adult === true, terms: b.terms === true, betaCodeOk: checkAccessCode(str(b.code, 100)), clientIp,
      }
    : { pseudo: str(b.pseudo, 40), password: str(b.password, 200), clientIp };

  let r: Response;
  try {
    r = await fetch(`${gameServerBase()}/auth/${signup ? "signup" : "login"}`, {
      method: "POST",
      headers: { authorization: `Bearer ${signServiceToken(key)}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    return NextResponse.json({ error: "Le serveur ne répond pas (il se réveille peut-être) : réessaie dans une minute." }, { status: 502 });
  }
  const data = (await r.json().catch(() => ({}))) as { userId?: string; flag?: string | null; error?: string };
  if (!r.ok || !data.userId) {
    const msg = (data.error && MESSAGES[data.error]) || (r.status === 429 ? MESSAGES.TOO_MANY_ATTEMPTS : "Le serveur ne répond pas correctement : réessaie dans une minute.");
    if (r.status === 401 || r.status === 403) await new Promise((res) => setTimeout(res, 400)); // freine les essais en rafale
    return NextResponse.json({ error: msg, code: data.error }, { status: r.ok ? 502 : r.status });
  }
  const sess = { userId: data.userId, ...(data.flag ? { flag: data.flag } : {}) };
  const res = NextResponse.json(sess);
  res.cookies.set(SESSION_COOKIE, signSession(sess, key), {
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
