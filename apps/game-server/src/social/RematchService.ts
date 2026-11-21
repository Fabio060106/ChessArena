import type { Stake, TimeControlId } from "@chessarena/shared";

/** Délai pendant lequel une revanche peut être proposée après la partie. */
export const REMATCH_WINDOW_MS = 2 * 60_000;

interface Finished {
  white: string;
  black: string;
  timeControl: TimeControlId;
  stake: Stake;
  rated: boolean;
  endedAt: number;
  offeredBy: string | null;
}

export type RematchDecision =
  | { kind: "offered"; by: string }
  | { kind: "accepted"; white: string; black: string; timeControl: TimeControlId; stake: Stake; rated: boolean }
  | { kind: "error"; code: "NO_GAME" | "NOT_A_PLAYER" | "EXPIRED" };

/**
 * Revanches des parties hors tournoi : l'un propose, l'autre accepte (en proposant à son tour),
 * et la nouvelle partie se joue avec les couleurs inversées, même cadence, même mise.
 * Une partie terminée ne donne lieu qu'à UNE revanche (pas de double création si les deux cliquent).
 */
export class RematchService {
  private readonly games = new Map<string, Finished>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** À appeler à la fin de chaque partie hors tournoi. */
  finished(gameId: string, g: Omit<Finished, "endedAt" | "offeredBy">): void {
    this.sweep();
    this.games.set(gameId, { ...g, endedAt: this.now(), offeredBy: null });
  }

  offer(gameId: string, userId: string): RematchDecision {
    const g = this.games.get(gameId);
    if (!g) return { kind: "error", code: "NO_GAME" };
    if (userId !== g.white && userId !== g.black) return { kind: "error", code: "NOT_A_PLAYER" };
    if (this.now() - g.endedAt > REMATCH_WINDOW_MS) { this.games.delete(gameId); return { kind: "error", code: "EXPIRED" }; }
    if (g.offeredBy && g.offeredBy !== userId) {
      this.games.delete(gameId); // une seule revanche par partie
      return { kind: "accepted", white: g.black, black: g.white, timeControl: g.timeControl, stake: g.stake, rated: g.rated };
    }
    g.offeredBy = userId;
    return { kind: "offered", by: userId };
  }

  /** Refus (par l'adversaire) ou retrait (par celui qui propose). Retourne les deux joueurs à prévenir. */
  decline(gameId: string, userId: string): [string, string] | null {
    const g = this.games.get(gameId);
    if (!g || (userId !== g.white && userId !== g.black)) return null;
    g.offeredBy = null;
    return [g.white, g.black];
  }

  /** Remet une partie dans le registre (la création de la revanche a échoué : on peut réessayer). */
  restore(gameId: string, g: Omit<Finished, "endedAt" | "offeredBy">): void {
    this.games.set(gameId, { ...g, endedAt: this.now(), offeredBy: null });
  }

  /** Le joueur s'en va (déconnexion, file d'attente) : ses propositions sont retirées. */
  withdrawAll(userId: string): Array<{ gameId: string; players: [string, string] }> {
    const out: Array<{ gameId: string; players: [string, string] }> = [];
    for (const [gameId, g] of this.games) {
      if (g.offeredBy === userId) { g.offeredBy = null; out.push({ gameId, players: [g.white, g.black] }); }
    }
    return out;
  }

  /**
   * Le joueur n'est plus disponible (parti, nouvelle partie, file d'attente) : plus aucune revanche possible
   * pour ses parties terminées. Retourne les parties retirées, pour prévenir l'adversaire.
   */
  leave(userId: string): Array<{ gameId: string; players: [string, string] }> {
    const out: Array<{ gameId: string; players: [string, string] }> = [];
    for (const [gameId, g] of this.games) {
      if (g.white === userId || g.black === userId) { this.games.delete(gameId); out.push({ gameId, players: [g.white, g.black] }); }
    }
    return out;
  }

  players(gameId: string): [string, string] | null {
    const g = this.games.get(gameId);
    return g ? [g.white, g.black] : null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, g] of this.games) if (t - g.endedAt > REMATCH_WINDOW_MS) this.games.delete(id);
  }
}
