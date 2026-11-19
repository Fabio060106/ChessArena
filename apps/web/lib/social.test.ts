import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@chessarena/shared";
import { mergeChat } from "./chat";
import { pct } from "./social";

const msg = (id: number, text = `m${id}`): ChatMessage => ({ id, gameId: "g", channel: "players", userId: "ana", text, at: id });

describe("chat côté client", () => {
  it("fusionne direct et historique sans doublon, dans l'ordre du serveur, 100 messages au plus", () => {
    expect(mergeChat([msg(3), msg(1)], [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3]);
    const many = Array.from({ length: 150 }, (_, i) => msg(i + 1));
    const out = mergeChat([], many);
    expect(out).toHaveLength(100);
    expect(out[0]!.id).toBe(51);
  });
  it("pourcentages du bilan", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBe(0);
  });
});

import { cheatMetrics } from "./fairplay";
describe("revue anti-triche (organisateur)", () => {
  const n = 60;
  const played = Array.from({ length: n }, (_, i) => `m${i}`);
  it("coups identiques au moteur sans perte → très suspect ; jeu humain → normal ; partie trop courte → pas de jugement", () => {
    const flat = Array(n + 1).fill(20);
    const engineLike = cheatMetrics(flat, played, played, "w");
    expect(engineLike).toMatchObject({ level: "suspect", matchPct: 100, acpl: 0 });
    // l'ouverture n'est jamais comptée
    expect(engineLike.counted).toBe((n - 16) / 2);
    const evals = Array.from({ length: n + 1 }, (_, i) => (i % 4 === 1 ? -60 : 20));
    const human = cheatMetrics(evals, played.map((m, i) => (i % 3 === 0 ? m : "autre")), played, "w");
    expect(human.level).toBe("normal");
    expect(cheatMetrics(flat.slice(0, 21), played.slice(0, 20), played.slice(0, 20), "w").level).toBe("normal");
  });
  it("les positions déjà décidées (± 10) ne comptent pas", () => {
    const won = Array(n + 1).fill(1500);
    expect(cheatMetrics(won, played, played, "w").counted).toBe(0);
  });
});
