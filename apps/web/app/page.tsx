"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Logo } from "../components/Logo";
import { ThemeToggle } from "../components/ThemeToggle";
import { useRouter } from "next/navigation";

const FLAGS = ["", "FR", "BE", "CH", "CA", "MA", "DZ", "TN", "SN", "CI", "DE", "ES", "IT", "PT", "GB", "US", "BR", "SG"];

const flagEmoji = (c: string) => (c ? String.fromCodePoint(...[...c].map((x) => 0x1f1e6 + x.charCodeAt(0) - 65)) : "—");

/** Après connexion : la page demandée (ex. lien d'invitation /play?t=…), jamais un autre site. */
function nextPath(): string {
  if (typeof window === "undefined") return "/play";
  const n = new URLSearchParams(window.location.search).get("next") ?? "";
  return /^\/(play|history|repertoire|direct|classement|profil|partie|amis)(\/[\w-]{1,64})?(\?[\w=&%,-]*)?$/.test(n) ? n : "/play";
}

const KNOWN = "arena_has_account"; // ce navigateur a déjà un compte : on propose « Se connecter » d'abord
const input = "w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-text outline-none focus:border-neon/60";

/** Accueil : créer un compte (pseudo + mot de passe) ou se connecter. */
export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "login" | "reset">("signup");
  const [resetCode, setResetCode] = useState("");
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
    const body = mode === "signup" ? { mode, pseudo, password, flag, email, adult, terms, code }
      : mode === "reset" ? { action: "reset", pseudo, code: resetCode, password } : { mode, pseudo, password };
    const r = await fetch(mode === "reset" ? "/api/account/password" : "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
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

  const switchTo = (m: "signup" | "login" | "reset") => { setMode(m); setError(null); };

  return (
    <main className="arena-app relative grid place-items-center overflow-x-hidden px-4 py-8">
      <ThemeToggle className="absolute right-3 top-3" />
      <div className="w-full max-w-sm">
        <div className="mb-4 text-center">
          <h1 className="font-display text-4xl font-bold tracking-tight"><Logo /></h1>
          <p className="mt-1 text-sm text-muted">Duels et tournois d'échecs · bêta en jetons, sans valeur</p>
          {invited && <p className="mt-2 rounded-lg border border-neon/30 bg-neon/10 px-3 py-2 text-sm text-neon">Tu es invité à un tournoi : crée ton compte (30 secondes) pour le rejoindre.</p>}
        </div>

        <form onSubmit={submit} className="panel flex flex-col gap-4 p-6">
          {mode === "reset" ? (
            <div>
              <h2 className="font-semibold">Mot de passe oublié</h2>
              <p className="mt-1 text-sm text-muted">
                Demande un <strong className="text-text">code de réinitialisation</strong> à l'organisateur (Fabio).
                Entre-le ici avec ton pseudo, puis choisis un nouveau mot de passe. Le code est valable 48 h.
              </p>
            </div>
          ) : (
          <div className="grid grid-cols-2 rounded-lg bg-surface-2 p-0.5" role="tablist">
            {(["signup", "login"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => switchTo(m)}
                className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === m ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                {m === "signup" ? "Créer un compte" : "Se connecter"}
              </button>
            ))}
          </div>
          )}

          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="text-muted">Pseudo</span>
            <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} required minLength={3} maxLength={20}
              pattern="[A-Za-z0-9_\-]{3,20}" autoComplete="username" placeholder="magnus_06" autoCapitalize="none" className={input} />
          </label>
          {mode === "reset" && (
            <label className="flex min-w-0 flex-col gap-1.5 text-sm">
              <span className="text-muted">Code de réinitialisation</span>
              <input value={resetCode} onChange={(e) => setResetCode(e.target.value)} required minLength={8} maxLength={20}
                autoComplete="one-time-code" autoCapitalize="characters" placeholder="ABCD-EFGH" className={`${input} font-mono tracking-widest`} />
            </label>
          )}
          <label className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="flex justify-between text-muted">
              {mode === "reset" ? "Nouveau mot de passe" : "Mot de passe"}
              <button type="button" onClick={() => setShowPw((v) => !v)} className="text-xs hover:text-text">{showPw ? "masquer" : "afficher"}</button>
            </span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "login" ? 1 : 8} maxLength={128}
              type={showPw ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} className={input} />
            {mode !== "login" && <span className="text-xs text-muted">8 caractères minimum.</span>}
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
            {busy ? (mode === "signup" ? "Création du compte…" : "Connexion…") : mode === "signup" ? "Créer mon compte" : mode === "reset" ? "Changer le mot de passe et entrer" : "Entrer dans l'arène"}
          </button>
          {mode === "login" && (
            <button type="button" onClick={() => switchTo("reset")} className="text-center text-sm text-neon hover:underline">Mot de passe oublié ?</button>
          )}
          {mode === "reset" && (
            <button type="button" onClick={() => switchTo("login")} className="text-center text-sm text-muted hover:text-text">← Retour à la connexion</button>
          )}
        </form>

        {/* présentation publique (lue aussi par les moteurs de recherche) */}
        <section className="mt-6 text-sm text-muted" aria-label="Présentation">
          <h2 className="mb-2 text-center font-semibold text-text">Les échecs en ligne, entre amis ou en tournoi</h2>
          <ul className="grid gap-1.5">
            <li>♟ Parties rapides en bullet, blitz et rapide, avec classement Elo.</li>
            <li>🏆 Tournois de 3 à 128 joueurs, à créer en un clic et à partager par lien.</li>
            <li>🔍 Analyse de chaque partie avec Stockfish 19, et essai de tes propres coups.</li>
            <li>📚 Répertoire d'ouvertures construit à partir de tes parties, avec exercices.</li>
            <li>👁 Parties en direct, chat, revanche, profils et historique complet.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
