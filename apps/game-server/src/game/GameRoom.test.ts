import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_CONTROLS, type GameStateEvent, type PresenceEvent, type TimeControlId } from "@chessarena/shared";
import { GameRoom, type FinishedGame } from "./GameRoom.js";

const FIRST_MOVE_MS = 20_000;
const GRACE_MS = 30_000;

function setup(opts: { tc?: TimeControlId; fen?: string } = {}) {
  const finished: FinishedGame[] = [];
  const states: GameStateEvent[] = [];
  const presence: PresenceEvent[] = [];
  const moves: Array<{ ply: number; uci: string; san: string; chargedMs: number }> = [];
  const room = new GameRoom({
    id: "g1",
    white: { userId: "W", rating: 1500 },
    black: { userId: "B", rating: 1500 },
    timeControl: TIME_CONTROLS[opts.tc ?? "blitz_3_0"],
    stake: { currency: "PLAY", buyInCents: 200 },
    firstMoveTimeoutMs: FIRST_MOVE_MS,
    disconnectGraceMs: GRACE_MS,
    initialFen: opts.fen,
    hooks: {
      onState: (s) => states.push(s),
      onMove: (_id, ply, uci, san, chargedMs) => moves.push({ ply, uci, san, chargedMs }),
      onPresence: (p) => presence.push(p),
      onFinish: (g) => finished.push(g),
    },
  });
  /** joue une séquence en alternant les camps, en vérifiant que chaque coup est accepté */
  const playAll = (ucis: string[], lag = 0) => {
    for (const uci of ucis) {
      const user = room.state().turn === "w" ? "W" : "B";
      expect(room.play(user, uci, room.ply, lag), `${user} ${uci}`).toBeNull();
    }
  };
  return { room, finished, states, presence, moves, playAll };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GameRoom — légalité et contrôle des coups (ADR-3)", () => {
  it("refuse les coups invalides avec un code précis", () => {
    const { room } = setup();
    expect(room.play("X", "e2e4", 0)).toBe("NOT_A_PLAYER");
    expect(room.play("W", "e2-e4", 0)).toBe("BAD_FORMAT");
    expect(room.play("W", "e2e4qq", 0)).toBe("BAD_FORMAT");
    expect(room.play("B", "e7e5", 0)).toBe("NOT_YOUR_TURN");
    expect(room.play("W", "e2e5", 0)).toBe("ILLEGAL_MOVE");
    expect(room.play("W", "e2e4", 3)).toBe("STALE_PLY");
    expect(room.ply).toBe(0);
  });

  it("refuse une pièce de promotion sur un coup normal (e2e4q)", () => {
    const { room } = setup();
    expect(room.play("W", "e2e4q", 0)).toBe("ILLEGAL_MOVE");
    expect(room.ply).toBe(0);
    expect(room.play("W", "e2e4", 0)).toBeNull();
  });

  it("refuse un double envoi du même coup (anti-rejeu par ply)", () => {
    const { room } = setup();
    expect(room.play("W", "e2e4", 0)).toBeNull();
    expect(room.play("W", "e2e4", 0)).toBe("NOT_YOUR_TURN");
    expect(room.play("B", "e7e5", 0)).toBe("STALE_PLY");
    expect(room.play("B", "e7e5", 1)).toBeNull();
  });

  it("exige la pièce de promotion en UCI", () => {
    const { room } = setup({ fen: "8/P6k/8/8/8/8/8/K7 w - - 0 1" });
    expect(room.play("W", "a7a8", 0)).toBe("ILLEGAL_MOVE");
    expect(room.play("W", "a7a8n", 0)).toBeNull();
    expect(room.fen.startsWith("N7/")).toBe(true);
  });

  it("émet onMove et onState à chaque coup accepté", () => {
    const { states, moves, playAll } = setup();
    playAll(["e2e4", "c7c5"]);
    expect(moves.map((m) => m.san)).toEqual(["e4", "c5"]);
    expect(states.at(-1)).toMatchObject({ ply: 2, turn: "w", lastMoveUci: "c7c5" });
  });
});

describe("GameRoom — fins de partie décidées par le serveur", () => {
  it("mat du lion (fool's mate) : 0-1 checkmate, PGN complet", () => {
    const { finished, playAll } = setup();
    playAll(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ result: "0-1", termination: "checkmate", aborted: false });
    expect(finished[0]!.pgn).toMatch(/Qh4#/);
    expect(finished[0]!.pgn).toMatch(/\[Termination "checkmate"\]/);
  });

  it("pat", () => {
    const { finished, playAll } = setup({ fen: "7k/4Q3/6K1/8/8/8/8/8 w - - 0 1" });
    playAll(["e7f7"]);
    expect(finished[0]).toMatchObject({ result: "1/2-1/2", termination: "stalemate" });
  });

  it("triple répétition", () => {
    const { finished, playAll } = setup();
    const cycle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    playAll([...cycle, ...cycle]);
    expect(finished[0]).toMatchObject({ result: "1/2-1/2", termination: "repetition" });
  });

  it("abandon après 2 demi-coups = défaite", () => {
    const { room, finished, playAll } = setup();
    playAll(["e2e4", "e7e5"]);
    room.resign("W");
    expect(finished[0]).toMatchObject({ result: "0-1", termination: "resignation", aborted: false });
  });

  it("après la fin, toute action est ignorée ou refusée", () => {
    const { room, finished, playAll } = setup();
    playAll(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(room.play("W", "a2a3", room.ply)).toBe("GAME_OVER");
    room.resign("B");
    room.disconnect("W");
    expect(finished).toHaveLength(1);
  });
});

describe("GameRoom — annulation sans pénalité (< 2 demi-coups)", () => {
  it("les Blancs ne jouent pas en 20 s → annulée", () => {
    const { finished } = setup();
    vi.advanceTimersByTime(FIRST_MOVE_MS - 1);
    expect(finished).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(finished[0]).toMatchObject({ termination: "aborted", aborted: true, result: "1/2-1/2" });
  });

  it("les Noirs ont à leur tour 20 s après le 1er coup blanc", () => {
    const { finished, playAll } = setup();
    vi.advanceTimersByTime(15_000);
    playAll(["e2e4"]);
    vi.advanceTimersByTime(FIRST_MOVE_MS - 1);
    expect(finished).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(finished[0]!.aborted).toBe(true);
  });

  it("abandon à 0 ou 1 demi-coup → annulée, pas perdue", () => {
    const a = setup();
    a.room.resign("B");
    expect(a.finished[0]!.aborted).toBe(true);
    const b = setup();
    b.playAll(["e2e4"]);
    b.room.resign("W");
    expect(b.finished[0]).toMatchObject({ aborted: true, termination: "aborted" });
  });

  it("le délai d'annulation disparaît après 2 demi-coups", () => {
    const { finished, playAll } = setup({ tc: "rapid_5_0" });
    playAll(["e2e4", "e7e5"]);
    vi.advanceTimersByTime(FIRST_MOVE_MS * 3);
    expect(finished).toHaveLength(0);
  });
});

describe("GameRoom — pendule autoritaire (ADR-8)", () => {
  it("les 2 premiers demi-coups ne sont pas chronométrés", () => {
    const { room, moves, playAll } = setup();
    vi.advanceTimersByTime(10_000);
    playAll(["e2e4"]);
    vi.advanceTimersByTime(10_000);
    playAll(["e7e5"]);
    expect(moves.map((m) => m.chargedMs)).toEqual([0, 0]);
    expect(room.state()).toMatchObject({ whiteMs: 180_000, blackMs: 180_000 });
  });

  it("décompte par demi-coup + incrément (Blitz 3+2)", () => {
    const { room, moves, playAll } = setup({ tc: "blitz_3_2" });
    playAll(["e2e4", "e7e5"]);
    vi.advanceTimersByTime(5_000);
    playAll(["g1f3"]);
    expect(moves.at(-1)!.chargedMs).toBe(5_000);
    expect(room.state().whiteMs).toBe(180_000 - 5_000 + 2_000);
    vi.advanceTimersByTime(1_500);
    expect(room.state().blackMs).toBe(180_000 - 1_500); // le camp au trait est décompté en direct
  });

  it("compensation de lag : déduite du temps facturé, plafonnée à 250 ms", () => {
    const { room, moves } = setup();
    expect(room.play("W", "e2e4", 0)).toBeNull();
    expect(room.play("B", "e7e5", 1)).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(room.play("W", "g1f3", 2, 100)).toBeNull();
    expect(moves.at(-1)!.chargedMs).toBe(900);
    vi.advanceTimersByTime(1_000);
    expect(room.play("B", "b8c6", 3, 5_000)).toBeNull();
    expect(moves.at(-1)!.chargedMs).toBe(750);
    vi.advanceTimersByTime(100);
    expect(room.play("W", "f1c4", 4, 5_000)).toBeNull();
    expect(moves.at(-1)!.chargedMs).toBe(0); // jamais négatif
  });

  it("chute du drapeau → défaite au temps, coup tardif refusé", () => {
    const { room, finished, playAll } = setup({ tc: "bullet_1_0" });
    playAll(["e2e4", "e7e5"]);
    vi.advanceTimersByTime(60_000 + 250);
    expect(finished[0]).toMatchObject({ result: "0-1", termination: "timeout" });
    expect(room.play("W", "g1f3", 2)).toBe("GAME_OVER");
    expect(finished[0]!.pgn).not.toMatch(/Nf3/);
  });

  it("un coup en transit arrivé juste après la fin du temps est accepté grâce au lag mesuré", () => {
    const { room, finished } = setup({ tc: "bullet_1_0" });
    room.play("W", "e2e4", 0);
    room.play("B", "e7e5", 1);
    vi.advanceTimersByTime(60_000 + 100);
    expect(room.play("W", "g1f3", 2, 200)).toBeNull();
    expect(finished).toHaveLength(0);
    expect(room.state().whiteMs).toBe(100);
  });

  it("même cas sans lag mesuré → FLAGGED et défaite", () => {
    const { room, finished } = setup({ tc: "bullet_1_0" });
    room.play("W", "e2e4", 0);
    room.play("B", "e7e5", 1);
    vi.advanceTimersByTime(60_000 + 100);
    expect(room.play("W", "g1f3", 2, 0)).toBe("FLAGGED");
    expect(finished[0]).toMatchObject({ result: "0-1", termination: "timeout" });
  });

  it("chute contre un roi seul → nulle (FIDE)", () => {
    const { finished, playAll } = setup({ fen: "k7/8/8/8/8/8/8/3Q3K w - - 0 1" });
    playAll(["d1d2", "a8b8"]);
    vi.advanceTimersByTime(180_000 + 250);
    expect(finished[0]).toMatchObject({ result: "1/2-1/2", termination: "timeout_vs_insufficient_material" });
  });

  it("le camp au roi seul perd normalement au temps", () => {
    const { finished, playAll } = setup({ fen: "k7/8/8/8/8/8/8/3Q3K w - - 0 1" });
    playAll(["d1d2", "a8b8", "d2d3"]);
    vi.advanceTimersByTime(180_000 + 250);
    expect(finished[0]).toMatchObject({ result: "1-0", termination: "timeout" });
  });
});

describe("GameRoom — déconnexion et grâce de 30 s", () => {
  it("forfait après 30 s sans reconnexion ; la pendule continue de tourner", () => {
    const { room, finished, presence, playAll } = setup({ tc: "rapid_5_0" });
    playAll(["e2e4", "e7e5"]);
    room.disconnect("W");
    expect(presence.at(-1)).toMatchObject({ userId: "W", connected: false, graceMs: GRACE_MS });
    vi.advanceTimersByTime(10_000);
    expect(room.graceRemainingMs("W")).toBe(20_000);
    expect(room.state().whiteMs).toBe(300_000 - 10_000);
    vi.advanceTimersByTime(20_000);
    expect(finished[0]).toMatchObject({ result: "0-1", termination: "abandon" });
  });

  it("reconnexion dans le délai → la partie continue", () => {
    const { room, finished, presence, playAll } = setup({ tc: "rapid_5_0" });
    playAll(["e2e4", "e7e5"]);
    room.disconnect("B");
    vi.advanceTimersByTime(29_000);
    room.reconnect("B");
    expect(presence.at(-1)).toMatchObject({ userId: "B", connected: true });
    vi.advanceTimersByTime(60_000);
    expect(finished).toHaveLength(0);
    playAll(["g1f3"]);
  });

  it("déconnexions répétées n'empilent pas les timers", () => {
    const { room, finished, playAll } = setup({ tc: "rapid_5_0" });
    playAll(["e2e4", "e7e5"]);
    room.disconnect("W");
    room.disconnect("W");
    vi.advanceTimersByTime(GRACE_MS);
    expect(finished).toHaveLength(1);
  });

  it("déconnexion avant 2 demi-coups → annulée, pas perdue", () => {
    const { room, finished } = setup();
    room.disconnect("W");
    vi.advanceTimersByTime(GRACE_MS);
    expect(finished[0]!.aborted).toBe(true);
  });

  it("compte les pertes de focus par couleur", () => {
    const { room, finished, playAll } = setup();
    room.recordFocusLoss("B");
    room.recordFocusLoss("B");
    room.recordFocusLoss("X");
    playAll(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(finished[0]!.focusLoss).toEqual({ w: 0, b: 2 });
  });
});
