"use client";
import { AppearanceButton } from "./AppearancePanel";
import { ThemeToggle } from "./ThemeToggle";
import { ChallengeCenter } from "./ChallengeCenter";
import { useSettings } from "../lib/settings";
import { useEffect, useState } from "react";

const LINKS = [
  ["/play", "Jouer"],
  ["/ordinateur", "Contre l'ordi"],
  ["/tournois", "Tournois"],
  ["/clubs", "Clubs"],
  ["/analyse", "Analyse"],
  ["/direct", "En direct"],
  ["/amis", "Amis"],
  ["/classement", "Classement"],
  ["/history", "Mes parties"],
  ["/repertoire", "Répertoire"],
  ["/profil", "Mon profil"],
] as const;

/** Barre d'onglets du téléphone : les 4 rubriques principales, le reste dans « Plus ». */
const TABS = [
  ["/play", "Jouer", "♟"],
  ["/tournois", "Tournois", "🏆"],
  ["/clubs", "Clubs", "🏛"],
  ["/amis", "Amis", "👥"],
] as const;

/** Navigation principale : une rangée de liens (ordinateur) ; barre d'onglets en bas de l'écran (téléphone). */
export function SiteNav({ active }: { active?: (typeof LINKS)[number][0] }) {
  useSettings(); // applique l'interface choisie (sobre, texte plus grand) sur chaque page
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!more) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [more]);
  const inMore = !!active && !TABS.some(([h]) => h === active);
  // la barre d'onglets s'efface quand on descend dans la page et revient dès qu'on remonte (ou en haut de page)
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - last) < 6) return;
      setHidden(y > last && y > 80 && y + window.innerHeight < document.documentElement.scrollHeight - 4);
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <nav aria-label="Navigation" className="mx-auto max-w-[1400px] px-2 pb-2 sm:overflow-x-auto sm:px-3 lg:px-6">
      {/* téléphone : barre d'onglets fixe en bas */}
      <ul className={`fixed inset-x-0 bottom-0 z-[80] flex border-t border-line bg-ink/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-transform duration-200 sm:hidden ${hidden && !more ? "pointer-events-none translate-y-full" : ""}`} aria-label="Onglets">
        {TABS.map(([href, label, icon]) => (
          <li key={href} className="flex-1">
            <a href={href} aria-current={active === href ? "page" : undefined}
              className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${active === href ? "text-neon" : "text-muted"}`}>
              <span className="text-lg leading-none" aria-hidden>{icon}</span>{label}
            </a>
          </li>
        ))}
        <li className="flex-1">
          <button type="button" onClick={() => setMore(true)} aria-expanded={more}
            className={`flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${inMore ? "text-neon" : "text-muted"}`}>
            <span className="text-lg leading-none" aria-hidden>☰</span>Plus
          </button>
        </li>
      </ul>
      {more && (
        <div className="fixed inset-0 z-[95] sm:hidden" role="dialog" aria-label="Plus de rubriques">
          <button type="button" aria-label="Fermer" className="absolute inset-0 bg-ink/60" onClick={() => setMore(false)} />
          <div className="panel absolute inset-x-2 bottom-2 flex flex-col gap-1 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-2xl">
            {LINKS.filter(([h]) => !TABS.some(([t]) => t === h)).map(([href, label]) => (
              <a key={href} href={href} aria-current={active === href ? "page" : undefined}
                className={`rounded-lg px-3 py-3 text-sm font-semibold ${active === href ? "bg-surface-2 text-neon" : "text-text hover:bg-surface-2"}`}>{label}</a>
            ))}
            <div className="mt-1 flex gap-1 border-t border-line pt-2"><ThemeToggle /><AppearanceButton /></div>
          </div>
        </div>
      )}
      <ul className="hidden w-max gap-1 sm:flex">
        {LINKS.map(([href, label]) => (
          <li key={href}>
            <a href={href} aria-current={active === href ? "page" : undefined}
              className={`block whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold ${active === href ? "bg-surface-2 text-text ring-1 ring-neon/40" : "text-muted hover:bg-surface-2 hover:text-text"}`}>
              {label}
            </a>
          </li>
        ))}
        <li><ThemeToggle /></li>
        <li><AppearanceButton /></li>
      </ul>
      <ChallengeCenter />
    </nav>
  );
}

/** Bouton « retourner l'échiquier » (raccourci clavier : F). */
export function FlipButton({ onFlip, className = "" }: { onFlip: () => void; className?: string }) {
  return (
    <button type="button" onClick={onFlip} title="Retourner l'échiquier (touche F)" aria-label="Retourner l'échiquier"
      className={`rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-muted hover:text-text ${className}`}>⇅</button>
  );
}
