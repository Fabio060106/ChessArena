"use client";

const LINKS = [
  ["/play", "Jouer"],
  ["/direct", "En direct"],
  ["/classement", "Classement"],
  ["/history", "Mes parties"],
  ["/repertoire", "Répertoire"],
  ["/profil", "Mon profil"],
] as const;

/** Navigation principale : une rangée de liens, défilable sur mobile. */
export function SiteNav({ active }: { active?: (typeof LINKS)[number][0] }) {
  return (
    <nav aria-label="Navigation" className="mx-auto max-w-[1400px] overflow-x-auto px-2 pb-2 sm:px-3 lg:px-6">
      <ul className="flex w-max gap-1">
        {LINKS.map(([href, label]) => (
          <li key={href}>
            <a href={href} aria-current={active === href ? "page" : undefined}
              className={`block whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold ${active === href ? "bg-surface-2 text-text ring-1 ring-neon/40" : "text-muted hover:bg-surface-2 hover:text-text"}`}>
              {label}
            </a>
          </li>
        ))}
      </ul>
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
