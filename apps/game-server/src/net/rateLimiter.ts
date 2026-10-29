/**
 * Token bucket par socket : protège le p99 contre un client qui inonde le serveur
 * (bug front ou attaque). Un humain ne dépasse pas ~10 événements/s, même en bullet.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
