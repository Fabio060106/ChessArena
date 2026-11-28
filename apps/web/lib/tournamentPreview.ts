import { gameServerBase } from "./gameServerApi";
import { TC_LABEL } from "./social";
import { swissRoundsFor } from "./tournament";
import type { SngStatus, SngSystem, TimeControlId } from "@chessarena/shared";

/** Aperçu public d'un tournoi (lien partagé) : sans aucun nom de joueur, sauf l'organisateur. */
export interface TournamentPreview {
  name: string | null; createdBy: string | null; system: SngSystem; timeControl: TimeControlId; status: SngStatus;
  size: number; players: number; startsAt: string | null; arenaMinutes: number | null; totalRounds: number | null;
}

export async function fetchTournamentPreview(id: string): Promise<TournamentPreview | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const r = await fetch(`${gameServerBase()}/public/tournaments/${id}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4_000) });
    return r.ok ? ((await r.json()) as TournamentPreview) : null;
  } catch {
    return null;
  }
}

export const previewTitle = (t: TournamentPreview) => t.name ?? (t.createdBy ? `Tournoi de ${t.createdBy}` : "Tournoi d'échecs");

export function previewFormat(t: TournamentPreview): string {
  const f = t.system === "arena" ? `Arena ${t.arenaMinutes} min` : t.system === "swiss" ? `Suisse ${t.totalRounds ?? swissRoundsFor(t.size)} rondes` : "Élimination directe";
  return `${f} · ${TC_LABEL[t.timeControl]}`;
}

/** « samedi 28 novembre à 20:00 (heure de Paris) » : l'aperçu est rendu sur le serveur, on fixe le fuseau. */
export function previewWhen(t: TournamentPreview): string {
  if (t.status === "running") return "En cours : suis le classement en direct";
  if (t.status === "finished") return "Terminé : classement final";
  if (t.status === "cancelled") return "Annulé";
  if (!t.startsAt) return `${t.players}/${t.size} inscrits · départ dès que c'est complet`;
  const d = new Date(t.startsAt);
  const day = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Paris" });
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  return `${day} à ${hm} (heure de Paris) · ${t.players} inscrit${t.players > 1 ? "s" : ""}`;
}
