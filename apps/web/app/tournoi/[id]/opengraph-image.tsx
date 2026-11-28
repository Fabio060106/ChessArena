import { ImageResponse } from "next/og";
import { SITE_NAME } from "../../../lib/site";
import { fetchTournamentPreview, previewFormat, previewTitle, previewWhen } from "../../../lib/tournamentPreview";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Tournoi d'échecs";

/** Image d'aperçu du lien d'un tournoi : nom, format, heure, aux couleurs du site. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await fetchTournamentPreview(id);
  const title = t ? previewTitle(t) : "Tournoi d'échecs";
  const format = t ? previewFormat(t) : "Suisse · Arena · Élimination directe";
  const when = t ? previewWhen(t) : "Inscris-toi et joue en ligne";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "linear-gradient(135deg, #070b12 0%, #0d1726 60%, #0b2a33 100%)", color: "#e8eef6", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 34, fontWeight: 700 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "#22d3ee", display: "flex" }} /><span>Chess</span><span style={{ color: "#22d3ee", marginLeft: -16 }}>{SITE_NAME.replace(/^Chess/, "")}</span>
          <span style={{ marginLeft: 24, fontSize: 24, fontWeight: 600, color: "#22d3ee", border: "2px solid #22d3ee", borderRadius: 999, padding: "4px 18px" }}>TOURNOI</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: title.length > 28 ? 64 : 80, fontWeight: 800, lineHeight: 1.05 }}>{title}</div>
          <div style={{ fontSize: 38, color: "#9fb0c3" }}>{format}</div>
          <div style={{ fontSize: 38, color: "#f5c451", fontWeight: 700 }}>{when}</div>
        </div>
        <div style={{ fontSize: 28, color: "#9fb0c3" }}>Classement en direct · Inscription en un clic</div>
      </div>
    ),
    size,
  );
}
