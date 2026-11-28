"use client";

import { useEffect } from "react";

/** Erreur inattendue dans une page : message clair et bouton pour réessayer, jamais d'écran blanc. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="arena-app grid min-h-dvh place-items-center px-4 py-10">
      <div className="panel flex w-full max-w-md flex-col items-center gap-4 p-6 text-center">
        <p className="font-display text-4xl">♞</p>
        <h1 className="text-lg font-semibold">Oups, cette page a trébuché.</h1>
        <p className="text-sm text-muted">Une erreur inattendue s'est produite. Tes parties et ton compte ne sont pas touchés.</p>
        <div className="flex w-full flex-col gap-2 sm:flex-row">
          <button type="button" onClick={reset} className="neon-btn flex-1 rounded-lg px-3 py-2 font-semibold">Réessayer</button>
          <a href="/play" className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Retour au jeu</a>
        </div>
        {error.digest && <p className="tabular text-[11px] text-muted">Référence : {error.digest}</p>}
      </div>
    </main>
  );
}
