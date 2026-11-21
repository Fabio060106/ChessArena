import type { Color, GameOverEvent, GameStartEvent } from "@chessarena/shared";
/**
 * Titre et explication du résultat. Partie annulée : on dit pourquoi et ce que ça change
 * (hors tournoi : rien n'est compté ; en tournoi : celui qui n'a pas joué son premier coup perd le match).
 */
export function overText(over: GameOverEvent, start: GameStartEvent | null, me: Color, iWon: boolean | null): {
  title: string; tone: "win" | "loss" | "neutral"; line?: string; note?: string;
} {
  const t = start?.tournament ?? null;
  if (over.termination === "aborted") {
    const by = over.abortedBy ?? null;
    if (!t) {
      return {
        title: "Partie annulée", tone: "neutral", line: "Aucun coup joué à temps",
        note: by === null ? "La partie n'a pas commencé : elle n'est pas comptée (ni Elo, ni historique)."
          : by === me ? "Tu n'as pas joué ton premier coup à temps. La partie n'est pas comptée (ni Elo, ni historique)."
          : "Ton adversaire n'a pas joué son premier coup à temps. La partie n'est pas comptée (ni Elo, ni historique).",
      };
    }
    if (by === null) return { title: "Partie rejouée", tone: "neutral", line: "Personne n'a joué", note: "Aucun des deux joueurs n'est en cause : le match du tournoi est rejoué." };
    return by === me
      ? { title: "Défaite", tone: "loss", line: "Premier coup non joué à temps", note: "En tournoi, ne pas jouer son premier coup fait perdre le match : ton adversaire passe au tour suivant." }
      : { title: "Victoire", tone: "win", line: "Ton adversaire n'a pas joué", note: "Ton adversaire n'a pas joué son premier coup à temps : tu passes au tour suivant." };
  }
  if (t && iWon === null) {
    if (t.kind === "main") return { title: "Nulle", tone: "neutral", note: "Match nul : une revanche avec les couleurs inversées va départager. Elle démarre automatiquement." };
    if (t.kind === "rematch") return { title: "Nulle", tone: "neutral", note: "Encore nulle : place à l'Armageddon (la moins bonne tête de série a les Blancs ; en cas de nulle, les Noirs passent)." };
    const qualified = me === "b";
    return { title: qualified ? "Qualifié" : "Éliminé", tone: qualified ? "win" : "loss", note: "Nulle à l'Armageddon : ce sont les Noirs qui passent." };
  }
  return { title: iWon === null ? "Nulle" : iWon ? "Victoire" : "Défaite", tone: iWon === null ? "neutral" : iWon ? "win" : "loss" };
}
