import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_NAME } from "../../../lib/site";
import { TC_LABEL } from "../../../lib/social";
import { fetchLinkChallenge } from "../../../lib/linkPreview";

/** Aperçu du lien envoyé sur WhatsApp, Messenger… : « Fabio te défie aux échecs · Blitz 3+0 ». */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const c = await fetchLinkChallenge(code);
  const title = c ? `${c.from} te défie aux échecs · ${SITE_NAME}` : `Défi aux échecs · ${SITE_NAME}`;
  const description = c ? `${TC_LABEL[c.timeControl]} · partie classée, gratuite. Accepte et la partie commence tout de suite.` : "Ce défi n'est plus valable : joue une partie ou défie un ami à ton tour.";
  return { title, description, robots: { index: false }, openGraph: { title, description, type: "website" }, twitter: { card: "summary", title, description } };
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
