import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "../lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} — échecs en ligne, tournois et analyse Stockfish`, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: ["échecs", "échecs en ligne", "jouer aux échecs", "tournoi d'échecs", "blitz", "bullet", "Stockfish", "analyse de partie", "répertoire d'ouvertures", "classement Elo"],
  alternates: { canonical: "/" },
  openGraph: { type: "website", locale: "fr_FR", url: SITE_URL, siteName: SITE_NAME, title: `${SITE_NAME} — échecs en ligne`, description: SITE_DESCRIPTION },
  twitter: { card: "summary", title: `${SITE_NAME} — échecs en ligne`, description: SITE_DESCRIPTION },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0B0E14" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        {/* applique l'interface choisie AVANT l'affichage (pas de flash sombre pour l'interface sobre) */}
        <script dangerouslySetInnerHTML={{ __html: `try{var s=JSON.parse(localStorage.getItem("arena.settings.v1")||"{}");if(s.ui==="sobre"||(s.ui==="auto"&&matchMedia("(prefers-color-scheme: light)").matches))document.documentElement.dataset.ui="sobre";if(s.largeText)document.documentElement.dataset.text="large"}catch(e){}` }} />
      </head>
      <body className="bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">{children}</body>
    </html>
  );
}
