import type { Stake, TimeControlId } from "@chessarena/shared";

/**
 * Matchmaking 1v1 à fenêtre Elo élargissante.
 *
 * Files séparées par CADENCE × DEVISE × MISE (spec §4) : un Bullet ne rencontre
 * jamais un Rapid, un joueur PLAY jamais un joueur EUR, une mise de 2 jamais une de 5.
 *
 * Fenêtre d'un ticket : min(BASE + WIDEN × secondes d'attente, MAX).
 * Un appariement A–B exige |ΔElo| ≤ fenêtre(A) ET ≤ fenêtre(B) : un 1500 qui
 * attend depuis longtemps ne force pas un 1900 tout juste arrivé à l'affronter.
 *
 * Complexité d'un tick : O(n log n) par file (tri par Elo + recherche de voisins).
 */
export interface QueueTicket {
  userId: string;
  rating: number;
  timeControl: TimeControlId;
  stake: Stake;
  enqueuedAt: number;
}

export type MatchHandler = (a: QueueTicket, b: QueueTicket) => void;

export interface MatchmakerOptions {
  tickMs?: number;
  baseWindow?: number;
  widenPerSec?: number;
  maxWindow?: number;
  now?: () => number;
  /** false = pas de setInterval (tests : on appelle tick() à la main) */
  autoTick?: boolean;
}

export function queueKey(tc: TimeControlId, stake: Stake): string {
  return `${tc}|${stake.currency}|${stake.buyInCents}`;
}

export class Matchmaker {
  private readonly queues = new Map<string, QueueTicket[]>();
  private readonly byUser = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval> | null;
  private readonly now: () => number;
  readonly baseWindow: number;
  readonly widenPerSec: number;
  readonly maxWindow: number;

  constructor(private readonly onMatch: MatchHandler, o: MatchmakerOptions = {}) {
    this.now = o.now ?? (() => Date.now());
    this.baseWindow = o.baseWindow ?? 50;
    this.widenPerSec = o.widenPerSec ?? 25;
    this.maxWindow = o.maxWindow ?? 400;
    this.timer = o.autoTick === false ? null : setInterval(() => this.tick(), o.tickMs ?? 1_000);
    this.timer?.unref?.();
  }

  enqueue(t: Omit<QueueTicket, "enqueuedAt">): void {
    if (this.byUser.has(t.userId)) throw new Error("ALREADY_QUEUED");
    const key = queueKey(t.timeControl, t.stake);
    const q = this.queues.get(key) ?? [];
    q.push({ ...t, enqueuedAt: this.now() });
    this.queues.set(key, q);
    this.byUser.set(t.userId, key);
  }

  /** Retourne true si le joueur était en file. */
  dequeue(userId: string): boolean {
    const key = this.byUser.get(userId);
    if (!key) return false;
    const q = (this.queues.get(key) ?? []).filter((t) => t.userId !== userId);
    if (q.length) this.queues.set(key, q);
    else this.queues.delete(key);
    this.byUser.delete(userId);
    return true;
  }

  /** Retire (et retourne) tous les tickets satisfaisant `pred` — ex. coupure de l'argent réel. */
  dequeueWhere(pred: (t: QueueTicket) => boolean): QueueTicket[] {
    const removed: QueueTicket[] = [];
    for (const [key, q] of this.queues) {
      const keep = q.filter((t) => !pred(t));
      if (keep.length === q.length) continue;
      for (const t of q) if (pred(t)) { removed.push(t); this.byUser.delete(t.userId); }
      if (keep.length) this.queues.set(key, keep);
      else this.queues.delete(key);
    }
    return removed;
  }

  isQueued(userId: string): boolean {
    return this.byUser.has(userId);
  }

  /** Fenêtre Elo courante d'un ticket. */
  windowOf(t: QueueTicket): number {
    const waitedSec = Math.max(0, this.now() - t.enqueuedAt) / 1000;
    return Math.min(this.baseWindow + waitedSec * this.widenPerSec, this.maxWindow);
  }

  sizes(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([k, q]) => [k, q.length]));
  }

  /**
   * Appariement glouton : le plus ancien d'abord, avec le partenaire compatible le
   * plus proche en Elo. Les fenêtres sont calculées une fois par tick ; la recherche
   * du partenaire se fait par dichotomie dans la file triée par Elo, en s'éloignant
   * des deux côtés tant que l'écart reste dans la fenêtre → O(n log n + n·k).
   */
  tick(): number {
    const now = this.now();
    let matches = 0;
    for (const [key, q] of this.queues) {
      const n = q.length;
      if (n < 2) continue;
      const win = new Map<QueueTicket, number>();
      for (const t of q) {
        const waitedSec = Math.max(0, now - t.enqueuedAt) / 1000;
        win.set(t, Math.min(this.baseWindow + waitedSec * this.widenPerSec, this.maxWindow));
      }
      const byAge = [...q].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      const byRating = [...q].sort((a, b) => a.rating - b.rating);
      const pos = new Map<QueueTicket, number>(byRating.map((t, i) => [t, i]));
      const taken = new Set<QueueTicket>();

      for (const a of byAge) {
        if (taken.has(a)) continue;
        const wa = win.get(a)!;
        const i = pos.get(a)!;
        let best: QueueTicket | null = null;
        let bestDiff = Infinity;
        // vers le bas puis vers le haut ; arrêt dès que l'écart dépasse la fenêtre de A
        for (let j = i - 1; j >= 0; j--) {
          const b = byRating[j]!;
          const diff = a.rating - b.rating;
          if (diff > wa || diff >= bestDiff) break;
          if (!taken.has(b) && diff <= win.get(b)!) { best = b; bestDiff = diff; break; }
        }
        for (let j = i + 1; j < n; j++) {
          const b = byRating[j]!;
          const diff = b.rating - a.rating;
          if (diff > wa || diff >= bestDiff) break;
          if (!taken.has(b) && diff <= win.get(b)!) { best = b; bestDiff = diff; break; }
        }
        if (!best) continue;
        taken.add(a).add(best);
        this.byUser.delete(a.userId);
        this.byUser.delete(best.userId);
        matches++;
        try {
          this.onMatch(a, best);
        } catch (e) {
          console.error("[matchmaker] onMatch a levé une exception", e);
        }
      }
      const rest = q.filter((t) => !taken.has(t));
      if (rest.length) this.queues.set(key, rest);
      else this.queues.delete(key);
    }
    return matches;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
