/**
 * Estimation du lag réseau d'un socket, mesuré par le SERVEUR (ADR-8).
 *
 * Le serveur envoie `lag:probe` ; le client répond via l'ack. RTT = aller-retour
 * mesuré par l'horloge serveur. Lag retenu = RTT/2 du MEILLEUR des N derniers
 * échantillons : un client qui retarde volontairement ses acks pour gonfler sa
 * compensation n'y gagne rien (on prend le minimum), et il reste plafonné à 250 ms
 * par la pendule.
 */
export class LagTracker {
  private samples: number[] = [];

  constructor(private readonly window = 5) {}

  addRtt(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 5_000) return;
    this.samples.push(rttMs);
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** Lag aller simple estimé (ms). 0 tant qu'aucune mesure. */
  get oneWayMs(): number {
    if (this.samples.length === 0) return 0;
    return Math.min(...this.samples) / 2;
  }
}
