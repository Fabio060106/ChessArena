import { describe, expect, it } from "vitest";
import { basicSignals, timeRegularity } from "./basicSignals.js";

const base = { white: { userId: "W" }, black: { userId: "B" }, timeControl: "blitz_3_0" as const, focusLoss: { w: 0, b: 0 } };
/** temps des Blancs (indices pairs) et des Noirs (impairs) */
const times = (w: (i: number) => number, b: (i: number) => number, n = 60) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? w(i) : b(i)));

describe("anti-triche de base", () => {
  it("un humain (temps variés, peu de sorties d'onglet) n'est pas signalé", () => {
    const human = times((i) => [800, 6000, 2500, 14000, 1200, 4000][i % 6]!, (i) => [3000, 900, 20000, 5000][i % 4]!);
    const [w, b] = basicSignals({ ...base, moveTimesMs: human, focusLoss: { w: 1, b: 2 } });
    expect(w).toMatchObject({ userId: "W", flagged: false, reasons: [] });
    expect(b!.flagged).toBe(false);
  });

  it("sorties d'onglet répétées et temps métronomiques sont signalés (à revoir, sans sanction)", () => {
    const bot = times(() => 4000 + Math.round(Math.random() * 400), (i) => [500, 9000, 3000][i % 3]!);
    const [w, b] = basicSignals({ ...base, moveTimesMs: bot, focusLoss: { w: 0, b: 4 } });
    expect(w!.flagged).toBe(true);
    expect(w!.reasons[0]).toMatch(/anormalement réguliers/);
    expect(w!.timeCv!).toBeLessThan(0.25);
    expect(b!.reasons).toEqual(["a quitté l'onglet de la partie 4 fois"]);
  });

  it("pas de règle des temps en bullet, ni sur une partie trop courte", () => {
    const fast = times(() => 1600, () => 1600);
    expect(basicSignals({ ...base, timeControl: "bullet_1_0", moveTimesMs: fast })[0]!.flagged).toBe(false);
    expect(basicSignals({ ...base, moveTimesMs: fast.slice(0, 20) })[0]!.flagged).toBe(false);
    expect(timeRegularity([])).toBeNull();
  });
});
