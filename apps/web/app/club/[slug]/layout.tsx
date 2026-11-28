import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_NAME } from "../../../lib/site";
import { fetchClubPreview } from "../../../lib/clubPreview";

/** Aperçu du lien d'un club : « Rejoins Les Fous du Roi sur ChessAurum ». */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const c = await fetchClubPreview(slug);
  if (!c) return { title: `Club · ${SITE_NAME}` };
  const title = `${c.name} · club d'échecs sur ${SITE_NAME}`;
  const description = `${c.description ? `${c.description} · ` : ""}${c.memberCount} membre${c.memberCount > 1 ? "s" : ""}. Rejoins le club : classement interne et tournois du club en ligne.`;
  return { title, description, openGraph: { title, description, type: "website" }, twitter: { card: "summary_large_image", title, description } };
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
