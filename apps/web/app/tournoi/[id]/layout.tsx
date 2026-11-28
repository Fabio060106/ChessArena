import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_NAME } from "../../../lib/site";
import { fetchTournamentPreview, previewFormat, previewTitle, previewWhen } from "../../../lib/tournamentPreview";

/** Aperçu du lien partagé (WhatsApp, Messenger, Discord…) : nom, format, heure du tournoi. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const t = await fetchTournamentPreview(id);
  if (!t) return { title: `Tournoi · ${SITE_NAME}` };
  const title = `${previewTitle(t)} · ${SITE_NAME}`;
  const description = `${previewFormat(t)} · ${previewWhen(t)}. Inscris-toi et joue en ligne, classement en direct.`;
  return { title, description, openGraph: { title, description, type: "website" }, twitter: { card: "summary_large_image", title, description } };
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
