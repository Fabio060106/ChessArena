import { describe, expect, it } from "vitest";
import { ChatService, cleanChatText } from "./ChatService.js";
import { REMATCH_WINDOW_MS, RematchService } from "./RematchService.js";

describe("chat", () => {
  it("nettoie les messages et refuse les vides ou trop longs", () => {
    expect(cleanChatText("  bien   joué\n !  ")).toBe("bien joué !");
    expect(cleanChatText("a​‮b")).toBe("a b");
    expect(cleanChatText("   ")).toBe("EMPTY");
    expect(cleanChatText(42)).toBe("EMPTY");
    expect(cleanChatText("x".repeat(201))).toBe("TOO_LONG");
    expect(cleanChatText("é".repeat(200))).toBe("é".repeat(200));
  });

  it("limite le débit par joueur et sépare les canaux", () => {
    let t = 0;
    const c = new ChatService(() => t);
    for (let i = 0; i < 5; i++) expect(typeof c.post("g", "players", "ana", `m${i}`)).toBe("object");
    expect(c.post("g", "players", "ana", "spam")).toBe("RATE_LIMITED");
    expect(typeof c.post("g", "spectators", "bob", "allez")).toBe("object"); // un autre joueur n'est pas freiné
    t += 2_000;
    expect(typeof c.post("g", "players", "ana", "encore")).toBe("object");
    expect(c.history("g", ["players"]).map((m) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4", "encore"]);
    expect(c.history("g", ["players", "spectators"]).map((m) => m.userId)).toContain("bob");
  });

  it("l'historique disparaît 10 minutes après la fin de la partie", () => {
    let t = 0;
    const c = new ChatService(() => t);
    c.post("g", "players", "ana", "gg");
    c.ended("g");
    expect(c.history("g", ["players"])).toHaveLength(1);
    t += 11 * 60_000;
    c.ended("autre"); // déclenche le ménage
    expect(c.history("g", ["players"])).toHaveLength(0);
  });
});

describe("revanche", () => {
  const g = { white: "ana", black: "bob", timeControl: "blitz_3_0" as const, stake: { currency: "PLAY" as const, buyInCents: 100 }, rated: true };

  it("l'un propose, l'autre accepte : couleurs inversées, une seule revanche", () => {
    const r = new RematchService();
    r.finished("g1", g);
    expect(r.offer("g1", "carl")).toEqual({ kind: "error", code: "NOT_A_PLAYER" });
    expect(r.offer("g1", "ana")).toEqual({ kind: "offered", by: "ana" });
    expect(r.offer("g1", "ana")).toEqual({ kind: "offered", by: "ana" }); // re-proposer ne l'accepte pas
    expect(r.offer("g1", "bob")).toMatchObject({ kind: "accepted", white: "bob", black: "ana", timeControl: "blitz_3_0" });
    expect(r.offer("g1", "ana")).toEqual({ kind: "error", code: "NO_GAME" }); // déjà utilisée
  });

  it("refus, retrait au départ du joueur, expiration", () => {
    let t = 0;
    const r = new RematchService(() => t);
    r.finished("g1", g);
    r.offer("g1", "ana");
    expect(r.decline("g1", "bob")).toEqual(["ana", "bob"]);
    expect(r.offer("g1", "bob")).toEqual({ kind: "offered", by: "bob" }); // après un refus, l'offre repart de zéro
    expect(r.withdrawAll("bob")).toEqual([{ gameId: "g1", players: ["ana", "bob"] }]);
    expect(r.offer("g1", "ana")).toEqual({ kind: "offered", by: "ana" });
    t += REMATCH_WINDOW_MS + 1;
    expect(r.offer("g1", "bob")).toEqual({ kind: "error", code: "EXPIRED" });
  });
});
