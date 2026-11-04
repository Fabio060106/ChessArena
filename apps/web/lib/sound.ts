/**
 * Effets sonores via Web Audio API — synthétisés en temps réel, aucun fichier à charger
 * (zéro latence réseau, rien à précharger, rendu identique à toutes les fréquences
 * d'échantillonnage). Chaque son superpose plusieurs couches (transitoire de bruit filtré
 * + corps tonal) passées dans un compresseur, d'où un rendu net à fort comme à faible volume.
 *
 * Le contexte audio n'est créé qu'après un geste de l'utilisateur (règle des navigateurs) :
 * appeler `unlock()` dans un gestionnaire pointerdown/keydown.
 */
export type SoundName = "move" | "capture" | "check" | "castle" | "premove" | "lowTime" | "start" | "win" | "loss" | "draw";

type Ctx = AudioContext;

export class SoundEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private _volume = 0.7;
  private _muted = false;

  get volume(): number { return this._volume; }
  get muted(): boolean { return this._muted; }

  setVolume(v: number): void {
    this._volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this._muted ? 0 : this._volume, this.ctx.currentTime, 0.01);
  }

  setMuted(m: boolean): void {
    this._muted = m;
    this.setVolume(this._volume);
  }

  /** À appeler sur un geste utilisateur. Sans effet hors navigateur. */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC({ latencyHint: "interactive" });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 8;
      comp.ratio.value = 4;
      comp.attack.value = 0.002;
      comp.release.value = 0.12;
      const master = ctx.createGain();
      master.gain.value = this._muted ? 0 : this._volume;
      master.connect(comp).connect(ctx.destination);
      const len = Math.floor(ctx.sampleRate * 0.5);
      const noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = noise;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  play(name: SoundName): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this._muted || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.001;
    switch (name) {
      case "move": this.knock(t, 2100, 0.55); this.thump(t, 170, 0.35); break;
      case "capture": this.knock(t, 1500, 0.8); this.thump(t, 120, 0.55); this.knock(t + 0.028, 2600, 0.35); break;
      case "castle": this.knock(t, 2100, 0.5); this.thump(t, 170, 0.3); this.knock(t + 0.07, 1900, 0.45); this.thump(t + 0.07, 150, 0.25); break;
      case "check": this.knock(t, 2000, 0.5); this.tone(t + 0.01, 988, 0.13, 0.22, "triangle"); this.tone(t + 0.12, 1480, 0.18, 0.2, "triangle"); break;
      case "premove": this.knock(t, 3400, 0.18); break;
      case "lowTime": this.tone(t, 1046, 0.08, 0.28, "square", 2400); this.tone(t + 0.14, 1046, 0.08, 0.28, "square", 2400); break;
      case "start": this.tone(t, 523, 0.12, 0.18, "triangle"); this.tone(t + 0.1, 784, 0.2, 0.2, "triangle"); break;
      case "win": [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.09, f, i === 3 ? 0.55 : 0.16, 0.2, "triangle")); break;
      case "loss": [392, 311, 262].forEach((f, i) => this.tone(t + i * 0.16, f, i === 2 ? 0.6 : 0.22, 0.2, "sine")); break;
      case "draw": this.tone(t, 523, 0.25, 0.18, "sine"); this.tone(t + 0.18, 523, 0.35, 0.15, "sine"); break;
    }
  }

  /** Transitoire « bois » : bruit filtré passe-bande, enveloppe très courte. */
  private knock(t: number, freq: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.3, 0.09);
  }

  /** Corps grave : sinus avec chute de hauteur (impact sur l'échiquier). */
  private thump(t: number, freq: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(freq * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.14);
  }

  private tone(t: number, freq: number, dur: number, gain: number, type: OscillatorType, lowpass = 6000): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lowpass;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.setValueAtTime(gain, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
    o.connect(lp).connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.2);
  }
}

/** Instance unique par onglet. */
export const sound = new SoundEngine();

/** Son d'un coup selon son effet (priorité : échec > prise > roque > coup). */
export function moveSound(m: { captured: boolean; check: boolean; castle?: boolean }): SoundName {
  if (m.check) return "check";
  if (m.captured) return "capture";
  if (m.castle) return "castle";
  return "move";
}
