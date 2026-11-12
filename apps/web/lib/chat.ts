import type { ChatMessage } from "@chessarena/shared";

/** Fusionne des messages reçus (direct + historique) sans doublon, dans l'ordre du serveur. */
export function mergeChat(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<number, ChatMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-100);
}

export const CHAT_ERRORS: Record<string, string> = {
  RATE_LIMITED: "Doucement : attends un peu avant d'écrire à nouveau.",
  TOO_LONG: "Message trop long (200 caractères au plus).",
  EMPTY: "",
  NO_GAME: "Le chat de cette partie est fermé.",
  BAD_PAYLOAD: "Message refusé.",
  MUTED: "L'organisateur a désactivé ton chat.",
};

/** Heure courte d'un message (« 21:04 »). */
export const chatTime = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
