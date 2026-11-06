"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const FLAGS = ["", "FR", "BE", "CH", "CA", "MA", "DZ", "TN", "SN", "CI", "DE", "ES", "IT", "PT", "GB", "US", "BR", "SG"];

const flagEmoji = (c: string) => (c ? String.fromCodePoint(...[...c].map((x) => 0x1f1e6 + x.charCodeAt(0) - 65)) : "—");

/** Après connexion : la page demandée (ex. lien d'invitation /play?t=…), jamais un autre site. */
function nextPath(): string {
  if (typeof window === "undefined") return "/play";
  const n = new URLSearchParams(window.location.search).get("next") ?? "";
  return /^\/(play|history|repertoire)(\?[\w=&%-]*)?$/.test(n) ? n : "/play";
}

const KNOWN = "arena_has_account"; // ce navigateur a déjà un compte : on propose « Se connecter » d'abord
const input = "w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-text outline-none focus:border-neon/60";

/** Accueil : créer un compte (pseudo + mot de passe) ou se connecter. */
export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [pseudo, setPseudo] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [flag, setFlag] = useState("FR");
  const [email, setEmail] = useState("");
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [invited, setInvited] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" }).then((r) => { if (r.ok) router.replace(nextPath()); }, () => {});
    try { if (localStorage.getItem(KNOWN)) setMode("login"); } catch { /* navigation privée */ }
    setInvited(/^\/play\?t=/.test(nextPath()));
  }, [router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setSlow(false);
    slowTimer.current = setTimeout(() => setSlow(true), 3500);
    const body = mode === "signup" ? { mode, pseudo, password, flag, email, adult, terms, code } : { mode, pseudo, password };
    const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    clearTimeout(slowTimer.current);
    setBusy(false); setSlow(false);
    if (r?.ok) {
      try { localStorage.setItem(KNOWN, "1"); } catch { /* ignoré */ }
      return router.replace(nextPath());
    }
    const d = r ? ((await r.json().catch(() => ({}))) as { error?: string; code?: string }) : {};
    if (d.code === "CLAIM_CODE_REQUIRED") setNeedCode(true);
    if (d.code === "NO_PASSWORD_YET") { setMode("signup"); setNeedCode(true); }
    setError(d.error ?? (r ? "Refusé" : "Réseau indisponible"));
  };

  const switchTo = (m: "signup" | "login") => { setMode(m); setError(null); };

  return (
    <main className="arena-app grid place-items-center overflow-x-hidden px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-4 text-center">
          <h1 className="font-display text-4xl font-bold tracking-tight">Chess<span className="text-neon">Arena</span></h1>
          <p className="mt-1 text-sm text-muted">Duels et tournois d'échecs · bêta en jetons, sans valeur</p>
          {invited && <p className="mt-2 rounded-lg border border-neon/30 bg-neon/10 px-3 py-2 text-sm text-neon">Tu es invité à un tournoi : crée ton compte (30 secondes) pour le rejoindre.</p>}
        </div>

        <form onSubmit={submit} className="panel flex flex-col gap-4 p-6">
          <div className="grid grid-cols-2 rounded-lg bg-surface-2 p-0.5" role="tablist">
            {(["signup", "login"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => switchTo(m)}
                className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === m ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                {m === "signup" ? "Créer un compte" : "Se connecter"}
              </button>
            ))}
          </div>

          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="text-muted">Pseudo</span>
            <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} required minLength={3} maxLength={20}
              pattern="[A-Za-z0-9_\-]{3,20}" autoComplete="username" placeholder="magnus_06" autoCapitalize="none" className={input} />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="flex justify-between text-muted">
              Mot de passe
              <button type="button" onClick={() => setShowPw((v) => !v)} className="text-xs hover:text-text">{showPw ? "masquer" : "afficher"}</button>
            </span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "signup" ? 8 : 1} maxLength={128}
              type={showPw ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} className={input} />
            {mode === "signup" && <span className="text-xs text-muted">8 caractères minimum.</span>}
          </label>

          {mode === "signup" && (
            <>
              <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3">
                <label className="flex min-w-0 flex-col gap-1.5 text-sm">
                  <span className="text-muted">Drapeau</span>
                  <select value={flag} onChange={(e) => setFlag(e.target.value)} className={input}>
                    {FLAGS.map((f) => <option key={f} value={f}>{flagEmoji(f)} {f || "aucun"}</option>)}
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-1.5 text-sm">
                  <span className="text-muted">E-mail <span className="text-xs">(facultatif)</span></span>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" maxLength={254}
                    placeholder="pour récupérer ton compte" className={input} />
                </label>
              </div>
              {needCode && (
                <label className="flex min-w-0 flex-col gap-1.5 text-sm">
                  <span className="text-muted">Code d'invitation de la bêta</span>
                  <input value={code} onChange={(e) => setCode(e.target.value)} type="password" autoComplete="off" className={input} />
                  <span className="text-xs text-muted">Seulement pour récupérer un pseudo déjà utilisé pendant la bêta, avec son historique.</span>
                </label>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} required className="mt-0.5 accent-[var(--neon,#22d3ee)]" />
                <span>J'ai 18 ans ou plus.</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} required className="mt-0.5 accent-[var(--neon,#22d3ee)]" />
                <span>
                  J'accepte les <a href="/conditions" target="_blank" className="text-neon underline">conditions de la bêta</a> : parties en jetons sans valeur,
                  pas d'aide extérieure (moteur, autre personne) pendant les parties.
                </span>
              </label>
            </>
          )}

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {slow && <p className="text-sm text-muted">Le serveur se réveille, ça peut prendre jusqu'à une minute…</p>}
          <button type="submit" disabled={busy} className="neon-btn rounded-lg px-4 py-2.5 font-semibold disabled:opacity-60">
            {busy ? (mode === "signup" ? "Création du compte…" : "Connexion…") : mode === "signup" ? "Créer mon compte" : "Entrer dans l'arène"}
          </button>
          {mode === "login" && (
            <p className="text-center text-xs text-muted">Mot de passe oublié ? Contacte l'organisateur de la bêta.</p>
          )}
        </form>
      </div>
    </main>
  );
}
