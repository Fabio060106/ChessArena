"use client";
import { isLight, useSettings, type Settings } from "../lib/settings";

const NEXT: Record<Settings["ui"], Settings["ui"]> = { arena: "sobre", sobre: "auto", auto: "arena" };
const LABEL: Record<Settings["ui"], string> = { arena: "🌙 Sombre", sobre: "☀️ Clair", auto: "🖥 Auto" };

/** Bouton clair / sombre / automatique (suit l'appareil), visible sur toutes les pages. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [s, update] = useSettings();
  const now = isLight(s.ui) ? "clair" : "sombre";
  return (
    <button type="button" onClick={() => update({ ui: NEXT[s.ui] })}
      title={`Thème : ${LABEL[s.ui]}${s.ui === "auto" ? ` (actuellement ${now})` : ""} — cliquer pour changer`}
      aria-label={`Thème de l'interface : ${LABEL[s.ui].slice(2).trim()}. Changer`}
      className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-text ${className}`}>
      {LABEL[s.ui]}
    </button>
  );
}
