"use client";
import { useEffect, useState } from "react";

const KEY = "arena.welcome.v1";

/** Le joueur a joué (ou fermé la carte) : la carte de bienvenue ne revient plus sur cet appareil. */
export function markWelcomed(): void {
  try { localStorage.setItem(KEY, "1"); } catch { /* stockage indisponible : sans gravité */ }
}

/**
 * Première visite : trois façons de commencer. Disparaît après la première partie ou d'un clic.
 * (Affichée seulement quand le joueur n'est ni en partie ni en file.)
 */
export function WelcomeCard({ className = "" }: { className?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try { setShow(localStorage.getItem(KEY) !== "1"); } catch { setShow(false); }
  }, []);
  if (!show) return null;
  const close = () => { markWelcomed(); setShow(false); };
  return (
    <div className={className}>
      <section className="panel relative overflow-hidden border-neon/40 p-3" aria-label="Bienvenue">
        <div className="pointer-events-none absolute -right-10 -top-10 size-32 rounded-full bg-neon/15 blur-2xl" />
        <button type="button" onClick={close} aria-label="Fermer" className="absolute right-2 top-2 rounded-md px-2 py-0.5 text-muted hover:text-text">×</button>
        <p className="pr-6 text-sm font-semibold">Bienvenue sur ChessAurum ! Trois façons de commencer :</p>
        <ol className="mt-2 flex flex-col gap-1.5 text-sm">
          <li><span className="font-semibold text-neon">1.</span> Choisis une cadence ci-dessous : un adversaire de ton niveau en quelques secondes.</li>
          <li><span className="font-semibold text-neon">2.</span> <a href="/tournois" className="underline hover:text-neon">Inscris-toi à une Arena officielle</a> : gratuite, tous les soirs.</li>
          <li><span className="font-semibold text-neon">3.</span> Défie un ami avec un lien : il joue même sans compte.</li>
        </ol>
      </section>
    </div>
  );
}
