import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Métriques du chemin chaud. DoD Sprint 1 : `move_handling` p99 < 5 ms à 500 parties.
 * Mesure = du début du handler `game:move` jusqu'à l'émission des états (hors réseau).
 * Exposé en JSON sur GET /metrics (Prometheus au Sprint 4).
 */
export class LatencyRecorder {
  private readonly buf: Float64Array;
  private idx = 0;
  private count = 0;

  constructor(capacity = 50_000) {
    this.buf = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.buf[this.idx] = ms;
    this.idx = (this.idx + 1) % this.buf.length;
    this.count++;
  }

  reset(): void {
    this.idx = 0;
    this.count = 0;
  }

  summary(): { count: number; p50: number; p95: number; p99: number; max: number } {
    const n = Math.min(this.count, this.buf.length);
    if (n === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = Array.from(this.buf.subarray(0, n)).sort((a, b) => a - b);
    const q = (p: number) => round(sorted[Math.min(n - 1, Math.floor(p * n))]!);
    return { count: this.count, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: round(sorted[n - 1]!) };
  }
}

export class ServerMetrics {
  readonly moveHandling = new LatencyRecorder();
  private readonly loop: IntervalHistogram;
  movesAccepted = 0;
  movesRejected = 0;
  rateLimited = 0;

  constructor() {
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
  }

  snapshot(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extra,
      moveHandlingMs: this.moveHandling.summary(),
      eventLoopDelayMs: {
        p50: round(this.loop.percentile(50) / 1e6),
        p99: round(this.loop.percentile(99) / 1e6),
        max: round(this.loop.max / 1e6),
      },
      movesAccepted: this.movesAccepted,
      movesRejected: this.movesRejected,
      rateLimited: this.rateLimited,
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    };
  }

  reset(): void {
    this.moveHandling.reset();
    this.loop.reset();
    this.movesAccepted = 0;
    this.movesRejected = 0;
    this.rateLimited = 0;
  }

  close(): void {
    this.loop.disable();
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
