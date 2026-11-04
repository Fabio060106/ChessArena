import { describe, expect, it } from "vitest";
import { GameManager } from "./GameManager.js";

/** Alternance des couleurs : on teste la règle seule, sans serveur. */
describe("GameManager — alternance des couleurs", () => {
  const gm = Object.create(GameManager.prototype) as unknown as Pick<GameManager, "pickColors"> & { lastColor: Map<string, "w" | "b"> };
  gm.lastColor = new Map();
  const a = { userId: "fabio" };
  const b = { userId: "papa" };
  const play = (rnd = 0.1) => {
    const [w, bl] = gm.pickColors(a, b, () => rnd);
    gm.lastColor.set(w.userId, "w");
    gm.lastColor.set(bl.userId, "b");
    return w.userId;
  };

  it("deux joueurs qui enchaînent les parties alternent Blancs / Noirs, quel que soit le tirage", () => {
    const first = play(0.1);
    const seq = [first, play(0.1), play(0.1), play(0.9), play(0.1), play(0.9)];
    expect(seq).toEqual([first, first === "fabio" ? "papa" : "fabio", first, first === "fabio" ? "papa" : "fabio", first, first === "fabio" ? "papa" : "fabio"]);
  });

  it("face à un nouveau joueur : celui qui sort des Noirs prend les Blancs ; celui qui sort des Blancs prend les Noirs", () => {
    gm.lastColor.clear();
    gm.lastColor.set("fabio", "b");
    expect(gm.pickColors(a, { userId: "nouveau" }, () => 0.99)[0].userId).toBe("fabio");
    gm.lastColor.set("fabio", "w");
    expect(gm.pickColors(a, { userId: "nouveau" }, () => 0.01)[0].userId).toBe("nouveau");
  });
});
