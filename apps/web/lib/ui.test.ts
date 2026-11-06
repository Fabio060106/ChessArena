import { describe, expect, it } from "vitest";
import type { GameStartEvent, GameStateEvent, SngSnapshot } from "@chessarena/shared";
import {
  applyRawMove, boardFromFen, checkedKing, enqueuePremove, premoveDests, reconcileSprites, squareToXY, takeNextPremove,
  tryLocalMove, virtualBoard, xyToSquare, type PieceSprite,
} from "./moves";
import { ClockSync, displayedClocks } from "./clock";
import { gameReducer, initialView, START_FEN } from "./gameReducer";
import { currentPairings, liveStandings, myTournament, prizeBreakdown, formatMoney } from "./tournament";
import { avatarFor, countryName, flagEmoji, materialAdvantage, pingQuality } from "./profile";
import { parseSettings, DEFAULT_SETTINGS } from "./settings";
import { moveSound } from "./sound";

const fenAfter = (...ucis: string[]) =>
  ucis.reduce((f, u) => tryLocalMove(f, u.slice(0, 2), u.slice(2, 4), (u[4] as "q" | undefined) || undefined)!.fen, START_FEN);

describe("plateau abstrait et pré-moves", () => {
  it("lit la FEN et applique roque, prise en passant et promotion sans règles", () => {
    const b = boardFromFen(START_FEN);
    expect(b.size).toBe(32);
    expect(b.get("e1")).toBe("wk");
    expect(b.get("d8")).toBe("bq");
    const castled = applyRawMove(boardFromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), "e1", "g1");
    expect(castled.get("g1")).toBe("wk");
    expect(castled.get("f1")).toBe("wr");
    expect(castled.has("h1")).toBe(false);
    const ep = applyRawMove(boardFromFen("8/8/8/3pP3/8/8/8/K6k w - d6 0 1"), "e5", "d6");
    expect(ep.get("d6")).toBe("wp");
    expect(ep.has("d5")).toBe(false);
    expect(applyRawMove(boardFromFen("8/P6k/8/8/8/8/8/K7 w - - 0 1"), "a7", "a8").get("a8")).toBe("wq");
    expect(applyRawMove(boardFromFen("8/P6k/8/8/8/8/8/K7 w - - 0 1"), "a7", "a8", "n").get("a8")).toBe("wn");
  });

  it("destinations de pré-move : géométrie seule (les obstacles peuvent disparaître)", () => {
    const b = boardFromFen(START_FEN);
    expect(premoveDests(b, "e2").sort()).toEqual(["d3", "e3", "e4", "f3"]);
    expect(premoveDests(b, "g1").sort()).toEqual(["e2", "f3", "h3"]);
    expect(premoveDests(b, "a1")).toHaveLength(14); // tour bloquée maintenant, libre plus tard
    expect(premoveDests(b, "e1")).toEqual(expect.arrayContaining(["g1", "c1", "d2"]));
    expect(premoveDests(b, "e4")).toEqual([]);
  });

  it("file illimitée : chaque pré-move est validé sur la position virtuelle", () => {
    const fen = fenAfter("e2e4"); // aux Noirs ; je suis Blanc et je prépare 3 coups
    let q = enqueuePremove(fen, [], { from: "g1", to: "f3" }, "w")!;
    q = enqueuePremove(fen, q, { from: "f1", to: "c4" }, "w")!;
    q = enqueuePremove(fen, q, { from: "e1", to: "g1" }, "w")!; // roque après avoir libéré f1 et g1
    expect(q).toHaveLength(3);
    const v = virtualBoard(fen, q);
    expect(v.get("g1")).toBe("wk");
    expect(v.get("f1")).toBe("wr");
    expect(enqueuePremove(fen, q, { from: "g1", to: "g3" }, "w")).toBeNull(); // le roi ne saute pas 2 cases
    expect(enqueuePremove(fen, q, { from: "e7", to: "e5" }, "w")).toBeNull(); // pas une pièce à moi
    expect(enqueuePremove(fen, q, { from: "a2", to: "a2" }, "w")).toBeNull();
  });

  it("exécution : la tête de file part si légale ; sinon toute la file est abandonnée", () => {
    const queue = [{ from: "g1", to: "f3" }, { from: "f1", to: "c4" }];
    const ok = takeNextPremove(fenAfter("e2e4", "e7e5"), queue);
    expect(ok.move?.uci).toBe("g1f3");
    expect(ok.rest).toEqual([{ from: "f1", to: "c4" }]);
    // échec reçu entre-temps : le développement prévu n'est plus légal → la file entière tombe
    const inCheck = fenAfter("e2e4", "e7e5", "f2f4", "d8h4");
    expect(takeNextPremove(inCheck, [{ from: "g1", to: "f3" }, { from: "f1", to: "c4" }])).toEqual({ move: null, rest: [] });
    expect(takeNextPremove(inCheck, [{ from: "g2", to: "g3" }]).move?.uci).toBe("g2g3");
    const illegal = takeNextPremove(fenAfter("e2e4", "e7e5"), [{ from: "e4", to: "e5" }, { from: "g1", to: "f3" }]);
    expect(illegal).toEqual({ move: null, rest: [] });
  });

  it("sprites : identité conservée pour animer, prise retirée, promotion = nouvelle pièce", () => {
    let n = 0;
    const id = () => `s${++n}`;
    const s0 = reconcileSprites([], boardFromFen(START_FEN), id);
    expect(s0).toHaveLength(32);
    const knight = s0.find((s) => s.square === "g1")!;
    const s1 = reconcileSprites(s0, boardFromFen(fenAfter("g1f3")), id);
    expect(s1.find((s) => s.square === "f3")!.id).toBe(knight.id); // même élément → il glisse
    expect(new Set(s1.map((s) => s.id)).size).toBe(32);
    // capture : 31 pièces, l'identité du preneur est conservée
    const capFen = fenAfter("e2e4", "d7d5", "e4d5");
    const s2 = reconcileSprites(reconcileSprites(s1, boardFromFen(fenAfter("g1f3", "d7d5")), id), boardFromFen(capFen), id);
    expect(s2).toHaveLength(31);
    // promotion : le pion disparaît, une dame apparaît avec un nouvel id
    const before: PieceSprite[] = [{ id: "p", code: "wp", square: "a7" }, { id: "k", code: "wk", square: "a1" }, { id: "K", code: "bk", square: "h7" }];
    const after = reconcileSprites(before, boardFromFen("Q7/7k/8/8/8/8/8/K7 b - - 0 1"), () => "new");
    expect(after.find((s) => s.square === "a8")).toEqual({ id: "new", code: "wq", square: "a8" });
    expect(after.find((s) => s.id === "p")).toBeUndefined();
  });

  it("coordonnées d'affichage dans les deux orientations, et cases en échec", () => {
    expect(squareToXY("a8", "w")).toEqual({ x: 0, y: 0 });
    expect(squareToXY("a8", "b")).toEqual({ x: 7, y: 7 });
    expect(squareToXY("h1", "b")).toEqual({ x: 0, y: 0 });
    for (const sq of ["a1", "e4", "h8", "c6"]) for (const o of ["w", "b"] as const) {
      const { x, y } = squareToXY(sq, o);
      expect(xyToSquare(x, y, o)).toBe(sq);
    }
    expect(xyToSquare(8, 0, "w")).toBeNull();
    expect(checkedKing(START_FEN)).toBeNull();
    expect(checkedKing(fenAfter("e2e4", "f7f6", "d1h5"))).toBe("e8");
  });

  it("son d'un coup : échec > prise > roque > coup", () => {
    expect(moveSound({ captured: true, check: true })).toBe("check");
    expect(moveSound({ captured: true, check: false })).toBe("capture");
    expect(moveSound({ captured: false, check: false, castle: true })).toBe("castle");
    expect(tryLocalMove("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1", "g1")?.castle).toBe(true);
  });
});

describe("synchronisation d'horloge", () => {
  it("garde le meilleur RTT, borne l'erreur, et se cale sur la base monotone", () => {
    const s = new ClockSync();
    expect(s.ready).toBe(false);
    s.add(1_000, 1_080, 50_040); // RTT 80 → offset 49 000
    s.add(2_000, 2_020, 51_010); // RTT 20 → offset 49 000
    s.add(3_000, 3_400, 52_900); // RTT 400, bruité, ignoré au profit du meilleur
    expect(s.rttMs).toBe(20);
    expect(s.offsetMs).toBe(49_000);
    expect(s.errorBoundMs).toBe(10);
    expect(s.serverNow(10_000)).toBe(59_000);
    // la pendule affichée se calcule à la milliseconde près à partir de cet offset
    const st = { whiteMs: 9_999, blackMs: 60_000, turn: "w" as const, ply: 2, serverTs: 59_000 };
    expect(displayedClocks(st, s.offsetMs, 10_123)).toEqual({ w: 9_876, b: 60_000 });
  });
});

describe("historique et réseau dans le reducer", () => {
  const start: GameStartEvent = {
    gameId: "g", white: { userId: "me", rating: 1500, flag: "FR" }, black: { userId: "op", rating: 1510 },
    timeControl: { id: "blitz_3_0", initialMs: 180_000, incrementMs: 0 }, stake: { currency: "PLAY", buyInCents: 0 }, fen: START_FEN,
  };
  const state = (p: Partial<GameStateEvent>): GameStateEvent => ({
    gameId: "g", fen: START_FEN, lastMoveUci: null, ply: 0, whiteMs: 180_000, blackMs: 180_000, turn: "w", serverTs: 0, ...p,
  });

  it("reconstruit la notation SAN et marque les trous après reconnexion", () => {
    let v = [
      { type: "start", start, userId: "me" },
      { type: "state", state: state({}) },
      { type: "state", state: state({ ply: 1, fen: fenAfter("e2e4"), lastMoveUci: "e2e4", turn: "b" }) },
      { type: "state", state: state({ ply: 2, fen: fenAfter("e2e4", "e7e5"), lastMoveUci: "e7e5" }) },
      { type: "state", state: state({ ply: 2, fen: fenAfter("e2e4", "e7e5"), lastMoveUci: "e7e5" }) }, // doublon
    ].reduce((s, a) => gameReducer(s, a as Parameters<typeof gameReducer>[1]), initialView);
    expect(v.moves).toEqual(["e4", "e5"]);
    v = gameReducer(v, { type: "state", state: state({ ply: 4, fen: fenAfter("e2e4", "e7e5", "g1f3", "b8c6"), lastMoveUci: "b8c6" }) });
    expect(v.moves).toEqual(["e4", "e5", null, null]);
  });

  it("ping : seuls les événements de la partie courante sont retenus", () => {
    let v = gameReducer(initialView, { type: "start", start, userId: "me" });
    v = gameReducer(v, { type: "net", net: { gameId: "g", rttMs: { w: 23, b: null } } });
    expect(v.net?.rttMs).toEqual({ w: 23, b: null });
    v = gameReducer(v, { type: "net", net: { gameId: "autre", rttMs: { w: 999, b: 999 } } });
    expect(v.net?.rttMs.w).toBe(23);
  });
});

describe("HUD Sit & Go", () => {
  const snap = (p: Partial<SngSnapshot>): SngSnapshot => ({
    id: "t1", formatId: "sng8", size: 8, timeControl: "blitz_3_0", currency: "PLAY", buyInCents: 500, sponsorAddedCents: 0,
    rakeBps: 1000, payoutBps: [6500, 3500], status: "registering", players: [], rounds: [], currentRound: 0,
    prizePoolCents: 3600, rakeCents: 0, cancelReason: null, createdAt: "2026-10-29T00:00:00Z", startedAt: null, finishedAt: null, ...p,
  });
  const pl = (userId: string, extra: Partial<SngSnapshot["players"][number]> = {}) => ({
    userId, rating: 1500, seed: null, status: "registered" as const, eliminatedRound: null, finalRank: null, payoutCents: 0, ...extra,
  });

  it("cagnotte : rake déduit des chiffres du serveur, structure des gains", () => {
    const b = prizeBreakdown(snap({}));
    expect(b).toMatchObject({ grossCents: 4000, rakeCents: 400, rakePct: 10, rakeSettled: false, poolCents: 3600 });
    expect(b.payouts).toEqual([{ rank: 1, cents: 2340, pct: 65 }, { rank: 2, cents: 1260, pct: 35 }]);
    const sponsored = prizeBreakdown(snap({ sponsorAddedCents: 1000, prizePoolCents: 4600 }));
    expect(sponsored.rakeCents).toBe(400);
    // terminé : gains réels du serveur (arrondis compris)
    const done = prizeBreakdown(snap({ status: "finished", rakeCents: 400, players: [pl("a", { finalRank: 1, payoutCents: 2341, status: "winner" }), pl("b", { finalRank: 2, payoutCents: 1259, status: "eliminated" })] }));
    expect(done.payouts.map((x) => x.cents)).toEqual([2341, 1259]);
    expect(done.rakeSettled).toBe(true);
    expect(formatMoney(2340, "PLAY")).toBe("23,40 jetons");
    expect(formatMoney(500, "EUR")).toBe("5 €");
  });

  it("classement live : vainqueur, en lice par tête de série, puis éliminés les plus tardifs d'abord", () => {
    const rows = liveStandings(snap({
      status: "running",
      players: [
        pl("early", { status: "eliminated", eliminatedRound: 0, seed: 1 }),
        pl("alive", { status: "registered", seed: 4 }),
        pl("playing", { status: "playing", seed: 2 }),
        pl("late", { status: "eliminated", eliminatedRound: 1, seed: 3 }),
        pl("gone", { status: "unregistered" }),
      ],
      rounds: [[{ round: 2, slot: 0, p1: "playing", p2: "x", winner: null, status: "playing", games: [] }]],
    }));
    expect(rows.map((r) => [r.userId, r.state])).toEqual([
      ["playing", "playing"], ["alive", "alive"], ["late", "eliminated"], ["early", "eliminated"],
    ]);
  });

  it("appariements du tour en cours (currentRound serveur 1-based, 0 = tout est joué)", () => {
    const m = (round: number, status: "pending" | "playing" | "done") => ({ round, slot: 0, p1: "a", p2: "b", winner: null, status, games: [] });
    const rounds = [[m(0, "done")], [m(1, "playing")], [m(2, "pending")]];
    expect(currentPairings(snap({ rounds, currentRound: 2 }))).toMatchObject({ round: 1, label: "Demi-finales" });
    expect(currentPairings(snap({ rounds, currentRound: 0 }))).toMatchObject({ round: 2, label: "Finale" });
    expect(currentPairings(snap({ rounds, currentRound: 1 }))?.label).toBe("Quarts de finale");
    expect(currentPairings(snap({}))).toBeNull();
  });

  it("tournoi courant du joueur : en cours > inscriptions > terminé ; jamais un tournoi quitté", () => {
    const a = snap({ id: "a", status: "finished", players: [pl("me", { status: "winner" })] });
    const b = snap({ id: "b", status: "running", players: [pl("me", { status: "playing" })] });
    const c = snap({ id: "c", status: "registering", players: [pl("me", { status: "unregistered" })] });
    expect(myTournament([a, b, c], "me")?.id).toBe("b");
    expect(myTournament([a, c], "me")?.id).toBe("a");
    expect(myTournament([c], "me")).toBeNull();
  });
});

describe("profils et préférences", () => {
  it("drapeau, pays, avatar stable, qualité du ping, avantage matériel", () => {
    expect(flagEmoji("fr")).toBe("🇫🇷");
    expect(flagEmoji("FRA")).toBeNull();
    expect(flagEmoji(undefined)).toBeNull();
    expect(countryName("FR")).toBe("France");
    expect(avatarFor("magnus-c")).toEqual(avatarFor("magnus-c"));
    expect(avatarFor("magnus-c").initials).toBe("MC");
    expect(avatarFor("alice").initials).toBe("AL");
    expect(pingQuality(null)).toBe("unknown");
    expect([pingQuality(25), pingQuality(120), pingQuality(400)]).toEqual(["good", "fair", "poor"]);
    expect(materialAdvantage(fenAfter("e2e4", "d7d5", "e4d5"), "w")).toBe(1);
    expect(materialAdvantage(fenAfter("e2e4", "d7d5", "e4d5"), "b")).toBe(0);
  });

  it("préférences : valeurs invalides ou stockage corrompu → défauts", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{pas du json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ boardTheme: "wood", soundOn: false, volume: 3 }))).toEqual({ ...DEFAULT_SETTINGS, boardTheme: "wood", soundOn: false });
    expect(parseSettings(JSON.stringify({ boardTheme: "neon-pink" })).boardTheme).toBe("cyberpunk");
  });
});

describe("accès bêta", () => {
  it("code d'invitation, session signée, jeton de jeu dérivé", async () => {
    const { checkAccessCode, readSession, signGameToken, signSession } = await import("./betaSession");
    const jwt = (await import("jsonwebtoken")).default;
    const key = "k".repeat(40);
    const prev = process.env.BETA_ACCESS_CODE;
    process.env.BETA_ACCESS_CODE = "echecs-2026";
    expect(checkAccessCode("echecs-2026")).toBe(true);
    expect(checkAccessCode(" echecs-2026 ")).toBe(true);
    expect(checkAccessCode("echecs-2027")).toBe(false);
    process.env.BETA_ACCESS_CODE = "";
    expect(checkAccessCode("")).toBe(false); // aucun code configuré = personne n'entre
    process.env.BETA_ACCESS_CODE = prev;

    const cookie = signSession({ userId: "fabio", flag: "FR" }, key);
    expect(readSession(cookie, key)).toEqual({ userId: "fabio", flag: "FR" });
    expect(readSession(cookie, "x".repeat(40))).toBeNull(); // mauvaise clé
    expect(readSession(signGameToken({ userId: "fabio" }, key), key)).toBeNull(); // un jeton de jeu n'est pas une session
    const game = jwt.verify(signGameToken({ userId: "fabio", flag: "FR" }, key), key) as Record<string, unknown>;
    expect(game).toMatchObject({ sub: "fabio", flag: "FR", state: "active", kyc: false });
    expect(Number(game.exp) - Number(game.iat)).toBe(900);
  });

  it("comptes : les anciennes sessions bêta (pseudo seul) ne sont plus valides ; le jeton de service n'est pas une session", async () => {
    const { readSession, signServiceToken } = await import("./betaSession");
    const jwt = (await import("jsonwebtoken")).default;
    const key = "k".repeat(40);
    const old = jwt.sign({ sub: "fabio" }, key, { algorithm: "HS256", audience: "chessarena-web-session", expiresIn: 3600 });
    expect(readSession(old, key)).toBeNull();
    expect(readSession(signServiceToken(key), key)).toBeNull();
    const svc = jwt.verify(signServiceToken(key), key, { audience: "chessarena-auth-service" }) as Record<string, unknown>;
    expect(Number(svc.exp) - Number(svc.iat)).toBe(60);
  });
});
