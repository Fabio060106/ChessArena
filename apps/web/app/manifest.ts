import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "../lib/site";

/** Application installable (écran d'accueil du téléphone) : plein écran, ouvre la page Jouer. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — échecs en ligne`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/play",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0B0E14",
    theme_color: "#0B0E14",
    lang: "fr",
    categories: ["games", "sports", "education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Jouer", url: "/play" },
      { name: "Tournois", url: "/tournois" },
      { name: "Clubs", url: "/clubs" },
      { name: "Répertoire", url: "/repertoire" },
    ],
  };
}
