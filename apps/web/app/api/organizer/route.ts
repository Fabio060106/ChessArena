import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSession, secret } from "../../../lib/betaSession";
import { callAuth } from "../../../lib/authService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACTIONS = new Set(["check", "reset-code", "reports", "report-done", "mute", "fairplay", "game", "fairplay-review", "suspend", "relays", "relay-add", "relay-remove"]);

/**
 * Espace organisateur : { action, ... }. Le pseudo connecté est transmis au serveur de jeu, qui seul
 * décide s'il est organisateur (variable ADMIN_USERS).
 */
export async function POST(req: NextRequest) {
  const key = secret();
  if (!key) return NextResponse.json({ error: "JWT_SECRET manquant côté web" }, { status: 500 });
  const s = readSession(req.cookies.get(SESSION_COOKIE)?.value, key);
  if (!s) return NextResponse.json({ error: "non connecté" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof b.action === "string" ? b.action : "";
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "action inconnue" }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : "");
  const r = await callAuth(`/auth/admin/${action}`, {
    by: s.userId, target: str(b.target), id: str(b.id), muted: b.muted === true,
    gameId: str(b.gameId), userId: str(b.userId), verdict: str(b.verdict), suspended: b.suspended === true,
    // retransmissions : lien LiveChessCloud, nom, ronde (0 = la plus récente)
    url: typeof b.url === "string" ? b.url.slice(0, 300) : "", name: typeof b.name === "string" ? b.name.slice(0, 80) : "",
    ...(Number.isInteger(b.round) ? { round: b.round } : {}),
  }, key);
  if (!r) return NextResponse.json({ error: "Le serveur ne répond pas : réessaie dans une minute." }, { status: 502 });
  return NextResponse.json(r.data, { status: r.status });
}
