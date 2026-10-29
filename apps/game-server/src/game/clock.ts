import type { Color, TimeControl } from "@chessarena/shared";

/**
 * Pendule autoritaire côté serveur (ADR-8). Le client n'affiche qu'une
 * extrapolation : seul le serveur constate une chute de drapeau.
 *
 * Décompte par demi-coup : à chaque `press(color)`, on facture le temps écoulé
 * depuis le début du tour, MOINS une compensation de lag :
 *     compensation = min(lag mesuré côté serveur, 250 ms, temps écoulé)
 * puis on ajoute l'incrément. Le lag provient de sondes initiées par le serveur
 * (cf. LagTracker) : le client ne peut pas déclarer un faux lag.
 */
export class ServerClock {
  static readonly MAX_LAG_COMP_MS = 250;

  private remaining: Record<Color, number>;
  private turnStartedAt: number | null = null;
  private running: Color | null = null;
  private flagTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly tc: TimeControl,
    private readonly onFlag: (color: Color) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.remaining = { w: tc.initialMs, b: tc.initialMs };
  }

  get runningColor(): Color | null {
    return this.running;
  }

  /** Démarre le décompte de `color` (sans facturer l'autre camp). */
  start(color: Color): void {
    this.running = color;
    this.turnStartedAt = this.now();
    this.armFlagTimer();
  }

  /**
   * `color` vient de jouer. Retourne le temps facturé (ms) ou `null` si son
   * drapeau était déjà tombé (dans ce cas `onFlag` a été appelé).
   */
  press(color: Color, lagMs = 0, at: number = this.now()): number | null {
    if (this.running !== color || this.turnStartedAt === null) return null;
    const elapsed = at - this.turnStartedAt;
    const comp = Math.min(Math.max(0, lagMs), ServerClock.MAX_LAG_COMP_MS, elapsed);
    const charged = elapsed - comp;
    const left = this.remaining[color] - charged;
    if (left <= 0) {
      this.flag(color);
      return null;
    }
    this.remaining[color] = left + this.tc.incrementMs;
    this.running = color === "w" ? "b" : "w";
    this.turnStartedAt = at;
    this.armFlagTimer();
    return charged;
  }

  /** Même calcul que press(), sans effet de bord : le coup arriverait-il drapeau tombé ? */
  wouldFlag(color: Color, lagMs = 0, at: number = this.now()): boolean {
    if (this.running !== color || this.turnStartedAt === null) return false;
    const elapsed = at - this.turnStartedAt;
    const comp = Math.min(Math.max(0, lagMs), ServerClock.MAX_LAG_COMP_MS, elapsed);
    return this.remaining[color] - (elapsed - comp) <= 0;
  }

  /** Temps restants à l'instant présent (le camp au trait est décompté en direct). */
  snapshot(): Record<Color, number> {
    const snap = { ...this.remaining };
    if (this.running && this.turnStartedAt !== null) {
      snap[this.running] = Math.max(0, snap[this.running] - (this.now() - this.turnStartedAt));
    }
    return snap;
  }

  stop(): void {
    if (this.flagTimer) clearTimeout(this.flagTimer);
    this.flagTimer = null;
    this.running = null;
    this.turnStartedAt = null;
  }

  private flag(color: Color): void {
    this.remaining[color] = 0;
    this.stop();
    this.onFlag(color);
  }

  /**
   * Timer de chute. On NE compense PAS le lag ici : un joueur dont le coup n'est
   * jamais arrivé n'a pas joué. Le +MAX_LAG_COMP_MS laisse à un coup en transit
   * la chance d'arriver et d'être compensé avant qu'on déclare la chute.
   */
  private armFlagTimer(): void {
    if (this.flagTimer) clearTimeout(this.flagTimer);
    const color = this.running;
    if (!color) return;
    this.flagTimer = setTimeout(() => {
      if (this.running !== color) return;
      if (this.snapshot()[color] <= 0) this.flag(color);
      else this.armFlagTimer();
    }, this.remaining[color] + ServerClock.MAX_LAG_COMP_MS);
  }
}
