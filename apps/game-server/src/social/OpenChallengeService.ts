import { randomInt } from "node:crypto";
import type { TimeControlId } from "@chessarena/shared";

/** Un lien de défi reste valable 30 minutes. */
export const LINK_TTL_MS = 30 * 60_000;

/** Alphabet sans caractères ambigus (0/o, 1/l/i). */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const LINK_CODE_RE = /^[a-hjkmnp-z2-9]{8}$/;

export interface OpenChallenge { code: string; from: string; timeControl: TimeControlId; createdAt: number }

/**
 * Défis par lien (« Joue contre moi ») : le premier joueur qui ouvre le lien et accepte joue contre le créateur.
 * Un seul lien ouvert par joueur (un nouveau remplace l'ancien) ; consommé à la première acceptation.
 */
export class OpenChallengeService {
  private readonly byCode = new Map<string, OpenChallenge & { timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly ttlMs = LINK_TTL_MS, private readonly onExpire: (c: OpenChallenge) => void = () => {}) {}

  create(from: string, timeControl: TimeControlId): OpenChallenge {
    for (const c of this.byCode.values()) if (c.from === from) this.remove(c.code);
    let code = "";
    do code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); while (this.byCode.has(code));
    const c = { code, from, timeControl, createdAt: Date.now() };
    const timer = setTimeout(() => { if (this.remove(code)) this.onExpire(c); }, this.ttlMs);
    timer.unref?.();
    this.byCode.set(code, { ...c, timer });
    return c;
  }

  get(code: string): OpenChallenge | null {
    const c = this.byCode.get(code);
    return c ? { code: c.code, from: c.from, timeControl: c.timeControl, createdAt: c.createdAt } : null;
  }

  of(from: string): OpenChallenge | null {
    for (const c of this.byCode.values()) if (c.from === from) return this.get(c.code);
    return null;
  }

  expiresAt(c: OpenChallenge): number { return c.createdAt + this.ttlMs; }

  /** true si le lien existait encore : une seule acceptation possible. */
  remove(code: string): boolean {
    const c = this.byCode.get(code);
    if (!c) return false;
    clearTimeout(c.timer);
    this.byCode.delete(code);
    return true;
  }
}
