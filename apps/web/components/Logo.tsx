import { SITE_NAME } from "../lib/site";

/** Logo texte : « Chess » + « Aurum » en couleur d'accent. */
export function Logo({ className = "" }: { className?: string }) {
  const cut = SITE_NAME.startsWith("Chess") ? 5 : Math.ceil(SITE_NAME.length / 2);
  return <span className={className}>{SITE_NAME.slice(0, cut)}<span className="text-neon">{SITE_NAME.slice(cut)}</span></span>;
}
