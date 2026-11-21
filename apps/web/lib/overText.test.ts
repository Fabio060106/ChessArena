import { describe, expect, it } from "vitest";
import type { GameOverEvent, GameStartEvent } from "@chessarena/shared";
import { overText } from "./overText";

const over = (o: Partial<GameOverEvent>): GameOverEvent => ({ gameId: "g", result: "1/2-1/2", termination: "aborted", pgn: "", payouts: {}, rakeCents: 0, ...o });
const start = (kind?: "main" | "rematch" | "armageddon") => ({ tournament: kind ? { tournamentId: "t", round: 1, kind } : null } as unknown as GameStartEvent);

describe("résultat affiché", () => {
  it("partie annulée hors tournoi : non comptée, sans « 1/2-1/2 »", () => {
    const o = overText(over({ abortedBy: "w" }), start(), "w", null);
    expect(o.title).toBe("Partie annulée");
    expect(o.line).toBe("Aucun coup joué à temps");
    expect(o.note).toMatch(/Tu n'as pas joué/);
  });
  it("partie annulée en tournoi : défaite pour celui qui n'a pas joué, victoire pour l'autre", () => {
    expect(overText(over({ abortedBy: "w" }), start("main"), "w", null)).toMatchObject({ title: "Défaite", tone: "loss" });
    expect(overText(over({ abortedBy: "w" }), start("main"), "b", null)).toMatchObject({ title: "Victoire", tone: "win" });
    expect(overText(over({ abortedBy: null }), start("main"), "b", null).title).toBe("Partie rejouée");
  });
  it("nulle en tournoi : on explique la suite (revanche, Armageddon)", () => {
    const d = over({ termination: "agreement" });
    expect(overText(d, start("main"), "w", null).note).toMatch(/revanche/);
    expect(overText(d, start("rematch"), "w", null).note).toMatch(/Armageddon/);
    expect(overText(d, start("armageddon"), "b", null).title).toBe("Qualifié");
    expect(overText(d, start("armageddon"), "w", null).title).toBe("Éliminé");
    expect(overText(over({ termination: "checkmate", result: "1-0" }), start(), "w", true).title).toBe("Victoire");
  });
});
