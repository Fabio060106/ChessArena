"use client";
import { useEffect } from "react";
import { useMe } from "../../hooks/useMe";

/** « Mon profil » : redirige vers /profil/<mon pseudo>. */
export default function MyProfile() {
  const me = useMe();
  useEffect(() => { if (me) window.location.replace(`/profil/${encodeURIComponent(me.userId)}`); }, [me]);
  return <main className="arena-app grid place-items-center text-sm text-muted">Chargement…</main>;
}
