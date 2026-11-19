import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/site";

/** Pages publiques indexables ; les espaces joueurs (connexion requise) et l'API ne le sont pas. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/conditions", "/analyse"], disallow: ["/api/", "/admin", "/organisateur", "/play", "/history", "/repertoire", "/direct", "/profil", "/classement", "/partie", "/amis"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
