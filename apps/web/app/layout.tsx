import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChessArena",
  description: "Compétition d'échecs en temps réel",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0B0E14" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        {/* applique l'interface choisie AVANT l'affichage (pas de flash sombre pour l'interface sobre) */}
        <script dangerouslySetInnerHTML={{ __html: `try{var s=JSON.parse(localStorage.getItem("arena.settings.v1")||"{}");if(s.ui==="sobre")document.documentElement.dataset.ui="sobre";if(s.largeText)document.documentElement.dataset.text="large"}catch(e){}` }} />
      </head>
      <body className="bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">{children}</body>
    </html>
  );
}
