import { describe, expect, it } from "vitest";
import type { GameStartEvent, GameStateEvent } from "@chessarena/shared";
import { bestSample, displayedClocks, formatClock, offsetFromPing } from "./clock";
import { isPromotion, resolvePremove, tryLocalMove } from "./moves";
import { gameReducer, initialView, isMyTurn, START_FEN, type GameView } from "./gameReducer";

describe("horloge client", () => {
  it("offset de Cristian et choix du meilleur échantillon", () => {
    expect(offsetFromPing(1000, 1100, 5050)).toEqual({ rttMs: 100, offsetMs: 4000 });
    expect(bestSample([{ rttMs: 80, offsetMs: 1 }, { rttMs: 30, offsetMs: 2 }, { rttMs: 50, offsetMs: 3 }])).toEqual({ rttMs: 30, offsetMs: 2 });
  });

  it("extrapole seulement le camp au trait, à partir du 3e demi-coup", () => {
    const st = { whiteMs: 60_000, blackMs: 50_000, turn: "w" as const, ply: 4, serverTs: 10_000 };
    expect(displayedClocks(st, 0, 12_500)).toEqual({ w: 57_500, b: 50_000 });
    expect(displayedClocks(st, 500, 12_000)).toEqual({ w: 57_500, b: 50_000 }); // client en retard de 500 ms
    expect(displayedClocks({ ...st, ply: 1 }, 0, 99_000)).toEqual({ w: 60_000, b: 50_000 });
    expect(displayedClocks(st, 0, 999_999)).toEqual({ w: 0, b: 50_000 });
    expect(displayedClocks(st, 0, 12_500, true)).toEqual({ w: 60_000, b: 50_000 });
  });

  it("formate comme une pendule de blitz", () => {
    expect(formatClock(180_000)).toBe("3:00");
    expect(formatClock(61_999)).toBe("1:01");
    expect(formatClock(20_000)).toBe("0:20");
    expect(formatClock(19_950)).toBe("19.9");
    expect(formatClock(-5)).toBe("0.0");
  });
});

describe("coups locaux", () => {
  it("valide, refuse, et gère la promotion", () => {
    expect(tryLocalMove(START_FEN, "e2", "e4")?.uci).toBe("e2e4");
    expect(tryLocalMove(START_FEN, "e2", "e5")).toBeNull();
    expect(tryLocalMove(START_FEN, "e2", "e4", "q")).toBeNull();
    const promo = "8/P6k/8/8/8/8/8/K7 w - - 0 1";
    expect(isPromotion(promo, "a7", "a8")).toBe(true);
    expect(isPromotion(START_FEN, "e2", "e4")).toBe(false);
    expect(tryLocalMove(promo, "a7", "a8")).toBeNull();
    expect(tryLocalMove(promo, "a7", "a8", "n")?.uci).toBe("a7a8n");
  });

  it("pré-move : exécuté s'il est légal dans la nouvelle position, dame par défaut", () => {
    const afterE4 = tryLocalMove(START_FEN, "e2", "e4")!.fen;
    expect(resolvePremove(afterE4, { from: "e7", to: "e5" })?.uci).toBe("e7e5");
    expect(resolvePremove(afterE4, { from: "e7", to: "e4" })).toBeNull();
    expect(resolvePremove("8/P6k/8/8/8/8/8/K7 w - - 0 1", { from: "a7", to: "a8" })?.uci).toBe("a7a8q");
  });
});

describe("gameReducer", () => {
  const start: GameStartEvent = {
    gameId: "g", white: { userId: "me", rating: 1500 }, black: { userId: "op", rating: 1510 },
    timeControl: { id: "blitz_3_0", initialMs: 180_000, incrementMs: 0 }, stake: { currency: "PLAY", buyInCents: 200 }, fen: START_FEN,
  };
  const state = (p: Partial<GameStateEvent>): GameStateEvent => ({
    gameId: "g", fen: START_FEN, lastMoveUci: null, ply: 0, whiteMs: 180_000, blackMs: 180_000, turn: "w", serverTs: 0, ...p,
  });
  const run = (...actions: Parameters<typeof gameReducer>[1][]): GameView => actions.reduce(gameReducer, initialView);

  it("cycle connexion → file → partie → fin", () => {
    let v = run({ type: "connected" }, { type: "queued", timeControl: "blitz_3_0", stake: start.stake });
    expect(v.phase).toBe("queued");
    v = gameReducer(v, { type: "start", start, userId: "op" });
    expect(v).toMatchObject({ phase: "playing", myColor: "b", queue: null });
    v = gameReducer(v, { type: "over", over: { gameId: "g", result: "1-0", termination: "resignation", pgn: "", payouts: {}, rakeCents: 0 } });
    expect(v.phase).toBe("over");
  });

  it("coup optimiste confirmé, puis rollback sur refus", () => {
    const e4 = tryLocalMove(START_FEN, "e2", "e4")!;
    let v = run({ type: "connected" }, { type: "start", start, userId: "me" }, { type: "state", state: state({}) });
    expect(isMyTurn(v)).toBe(true);
    v = gameReducer(v, { type: "optimistic_move", pending: { uci: "e2e4", ply: 0, fen: e4.fen } });
    expect(v.displayFen).toBe(e4.fen);
    expect(isMyTurn(v)).toBe(false); // pas de second coup tant que l'ack n'est pas arrivé
    v = gameReducer(v, { type: "move_rejected", code: "ILLEGAL_MOVE" });
    expect(v.displayFen).toBe(START_FEN);
    expect(v.error).toBe("ILLEGAL_MOVE");
  });

  it("ignore un état périmé et un état d'une autre partie", () => {
    let v = run({ type: "start", start, userId: "me" }, { type: "state", state: state({ ply: 5, fen: "x" }) });
    v = gameReducer(v, { type: "state", state: state({ ply: 3, fen: "old" }) });
    expect(v.displayFen).toBe("x");
    v = gameReducer(v, { type: "state", state: state({ gameId: "other", ply: 9, fen: "y" }) });
    expect(v.displayFen).toBe("x");
  });

  it("resynchro après reconnexion : même partie, pré-move conservé", () => {
    let v = run({ type: "start", start, userId: "op" }, { type: "set_premove", premove: { from: "e7", to: "e5" } });
    v = gameReducer(v, { type: "disconnected" });
    v = gameReducer(v, { type: "start", start, userId: "op" });
    expect(v.premove).toEqual({ from: "e7", to: "e5" });
  });

  it("présence : seule celle de l'adversaire est affichée", () => {
    let v = run({ type: "start", start, userId: "me" });
    v = gameReducer(v, { type: "presence", userId: "me", presence: { gameId: "g", userId: "op", connected: false, graceMs: 30_000 } });
    expect(v.opponentPresence?.graceMs).toBe(30_000);
    v = gameReducer(v, { type: "presence", userId: "me", presence: { gameId: "g", userId: "op", connected: true, graceMs: 0 } });
    expect(v.opponentPresence).toBeNull();
  });

  it("une erreur de file ramène au lobby", () => {
    const v = run({ type: "connected" }, { type: "queued", timeControl: "blitz_3_0", stake: start.stake }, { type: "error", code: "STAKE_LOCK_FAILED" });
    expect(v.phase).toBe("idle");
  });
});

import { evalToUnit, fensFromPgn, formatEval, gradeMove, longestStreak, moveNumber } from "./anticheatView";

describe("back-office anti-triche : transformations", () => {
  it("qualité d'un coup", () => {
    expect(gradeMove({ cpLoss: 0, matched: true, included: true })).toBe("best");
    expect(gradeMove({ cpLoss: 49, matched: false, included: true })).toBe("good");
    expect(gradeMove({ cpLoss: 50, matched: false, included: true })).toBe("inaccuracy");
    expect(gradeMove({ cpLoss: 100, matched: false, included: true })).toBe("mistake");
    expect(gradeMove({ cpLoss: 300, matched: false, included: true })).toBe("blunder");
  });
  it("échelle de la courbe : bornée, symétrique, monotone", () => {
    expect(evalToUnit(0)).toBe(0);
    expect(evalToUnit(10_000)).toBeLessThan(1);
    expect(evalToUnit(-300)).toBeCloseTo(-evalToUnit(300));
    expect(evalToUnit(200)).toBeGreaterThan(evalToUnit(100));
  });
  it("formats", () => {
    expect(formatEval(135)).toBe("+1.35");
    expect(formatEval(-40)).toBe("−0.40");
    expect(formatEval(0, 3)).toBe("M3");
    expect(formatEval(0, -2)).toBe("−M2");
    expect(moveNumber(0)).toBe("1.");
    expect(moveNumber(5)).toBe("3…");
    expect(longestStreak([true, true, false, true, true, true, false])).toBe(3);
  });
  it("positions issues du PGN (0 = initiale)", () => {
    const f = fensFromPgn("1. e4 e5 2. Nf3 *");
    expect(f).toHaveLength(4);
    expect(f[1]).toContain("4P3");
    expect(fensFromPgn("pas un pgn")).toHaveLength(1);
  });
});

describe("mode de session", () => {
  it("le serveur impose PLAY_MONEY_ONLY / LOCKED : état et bandeau", async () => {
    const { gameReducer, initialView, sessionBanner } = await import("./gameReducer");
    const s = gameReducer(initialView, { type: "session_mode", session: { mode: "PLAY_MONEY_ONLY", reason: "REAL_MONEY_DISABLED" } });
    expect(s.session?.mode).toBe("PLAY_MONEY_ONLY");
    expect(sessionBanner(s.session)).toMatch(/indisponible/);
    expect(sessionBanner({ mode: "LOCKED", reason: "SELF_EXCLUDED" })).toMatch(/Auto-exclusion/);
    expect(sessionBanner({ mode: "REAL_MONEY", reason: "OK" })).toBeNull();
    const q = gameReducer({ ...initialView, phase: "queued" }, { type: "error", code: "LIMIT_EXCEEDED" });
    expect(q.phase).toBe("idle");
  });
});
