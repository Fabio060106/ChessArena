import { ImageResponse } from "next/og";
import { SITE_NAME } from "../../../lib/site";
import { fetchClubPreview } from "../../../lib/clubPreview";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Club d'échecs";

/** Image d'aperçu du lien d'un club. */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await fetchClubPreview(slug);
  const name = c?.name ?? "Club d'échecs";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "linear-gradient(135deg, #070b12 0%, #141a10 55%, #2a230b 100%)", color: "#e8eef6", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 34 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "#22d3ee", display: "flex" }} /><span>Chess</span><span style={{ color: "#22d3ee", marginLeft: -16 }}>{SITE_NAME.replace(/^Chess/, "")}</span>
          <span style={{ marginLeft: 24, fontSize: 24, color: "#f5c451", border: "2px solid #f5c451", borderRadius: 999, padding: "4px 18px" }}>CLUB</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: name.length > 28 ? 64 : 80, lineHeight: 1.05 }}>{name}</div>
          {c?.description ? <div style={{ fontSize: 34, color: "#9fb0c3" }}>{c.description.slice(0, 110)}</div> : null}
          <div style={{ fontSize: 38, color: "#f5c451" }}>{c ? `${c.memberCount} membre${c.memberCount > 1 ? "s" : ""} · rejoins le club` : "Rejoins le club"}</div>
        </div>
        <div style={{ fontSize: 28, color: "#9fb0c3" }}>Classement du club · Tournois du club en ligne</div>
      </div>
    ),
    size,
  );
}
