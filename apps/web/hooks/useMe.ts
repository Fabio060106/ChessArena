"use client";
import { useCallback, useEffect, useState } from "react";

/** Joueur connecté (session) ; sinon redirection vers la page d'accueil, avec retour ici après connexion. */
export function useMe() {
  const [me, setMe] = useState<{ userId: string; flag?: string } | null>(null);
  useEffect(() => {
    const back = () => window.location.replace(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMe((await r.json()) as { userId: string; flag?: string }) : back()))
      .catch(back);
  }, []);
  return me;
}

/** Jeton de jeu pour le socket (renouvelé à chaque reconnexion). */
export function useGameAuth() {
  return useCallback(async () => {
    const r = await fetch("/api/token", { cache: "no-store" });
    return r.ok ? { token: ((await r.json()) as { token: string }).token } : {};
  }, []);
}
