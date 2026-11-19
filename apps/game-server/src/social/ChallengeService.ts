import { randomUUID } from "node:crypto";
import type { TimeControlId } from "@chessarena/shared";

/** Un défi reste ouvert 60 s, puis expire. */
export const CHALLENGE_TTL_MS = 60_000;

export interface Challenge {
  id: string;
  from: string;
  to: string;
  timeControl: TimeControlId;
  createdAt: number;
}

/**
 * Défis directs entre joueurs (amis ou non) : un seul défi sortant par joueur ; le défié accepte ou refuse ;
 * sans réponse, le défi expire. Une fois accepté (ou refusé), il disparaît : pas de double partie.
 */
export class ChallengeService {
  private readonly byId = new Map<string, Challenge & { timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly onExpire: (c: Challenge) => void, private readonly ttlMs = CHALLENGE_TTL_MS) {}

  create(from: string, to: string, timeControl: TimeControlId): Challenge {
    // un nouveau défi remplace le précédent du même joueur
    for (const c of this.byId.values()) if (c.from === from) this.remove(c.id);
    const c = { id: randomUUID(), from, to, timeControl, createdAt: Date.now() };
    const timer = setTimeout(() => { if (this.remove(c.id)) this.onExpire(c); }, this.ttlMs);
    timer.unref?.();
    this.byId.set(c.id, { ...c, timer });
    return c;
  }

  get(id: string): Challenge | null {
    const c = this.byId.get(id);
    return c ? { id: c.id, from: c.from, to: c.to, timeControl: c.timeControl, createdAt: c.createdAt } : null;
  }

  /** Retire le défi ; true s'il existait encore (garantit qu'une seule réponse est prise en compte). */
  remove(id: string): boolean {
    const c = this.byId.get(id);
    if (!c) return false;
    clearTimeout(c.timer);
    this.byId.delete(id);
    return true;
  }

  /** Défis impliquant ce joueur (déconnexion : on les annule). */
  involving(userId: string): Challenge[] {
    return [...this.byId.values()].filter((c) => c.from === userId || c.to === userId).map((c) => this.get(c.id)!);
  }

  /** Défis reçus encore ouverts (un joueur qui ouvre une nouvelle page les retrouve). */
  incomingFor(userId: string): Challenge[] {
    return [...this.byId.values()].filter((c) => c.to === userId).map((c) => this.get(c.id)!);
  }
}
