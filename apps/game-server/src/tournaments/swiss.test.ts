import { describe, expect, it } from "vitest";
import { defaultSwissRounds, pairRound, swissStandings, type SwissPlayer, type SwissResult } from "./swiss.js";

/** générateur pseudo-aléatoire déterministe */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Joue un tournoi complet : le mieux classé gagne le plus souvent. */
function simulate(n: number, rounds: number, seed: number) {
  const rand = rng(seed);
  const players: SwissPlayer[] = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: i + 1, pts2: 0, opponents: [], colors: [], hadBye: false }));
  const by = new Map(players.map((p) => [p.id, p]));
  const results: SwissResult[] = [];
  const byes: string[] = [];
  const pairings = [];
  for (let r = 1; r <= rounds; r++) {
    const pr = pairRound(players, rand);
    pairings.push(pr);
    for (const [w, b] of pr.boards) {
      const pw = by.get(w)!, pb = by.get(b)!;
      const x = rand();
      const favW = pw.seed < pb.seed;
      const w2 = x < 0.15 ? 1 : (x < 0.75) === favW ? 2 : 0;
      results.push({ white: w, black: b, w2 });
      pw.pts2 += w2; pb.pts2 += 2 - w2;
      pw.opponents.push(b); pb.opponents.push(w);
      pw.colors.push("w"); pb.colors.push("b");
    }
    if (pr.bye) { const p = by.get(pr.bye)!; p.pts2 += 2; p.hadBye = true; p.colors.push("-"); byes.push(pr.bye); }
  }
  return { players, results, byes, pairings };
}

describe("système suisse — appariements", () => {
  it("1re ronde : la moitié haute contre la moitié basse (1-5, 2-6, 3-7, 4-8)", () => {
    const { pairings } = simulate(8, 1, 1);
    const sorted = pairings[0]!.boards.map(([w, b]) => [w, b].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))).join("-"));
    expect(sorted).toEqual(["p1-p5", "p2-p6", "p3-p7", "p4-p8"]);
    // couleurs alternées d'un échiquier à l'autre
    const w = pairings[0]!.boards.map(([x]) => Number(x.slice(1)) <= 4);
    expect(w[0]).toBe(!w[1]);
  });

  it("nombre impair : un exempt, le moins bien classé, jamais deux fois le même", () => {
    const { pairings, byes } = simulate(7, 5, 2);
    expect(pairings[0]!.bye).toBe("p7");
    expect(new Set(byes).size).toBe(byes.length);
  });

  it("des centaines de tournois : chacun joue une fois par ronde, jamais deux fois le même adversaire, couleurs équilibrées", () => {
    for (let n = 3; n <= 40; n++) {
      for (let seed = 1; seed <= 6; seed++) {
        const rounds = defaultSwissRounds(n);
        const { players, pairings } = simulate(n, rounds, seed * 97 + n);
        for (const pr of pairings) {
          const ids = pr.boards.flat().concat(pr.bye ? [pr.bye] : []);
          expect(new Set(ids).size).toBe(n);
          expect(ids.length).toBe(n);
        }
        for (const p of players) {
          expect(new Set(p.opponents).size, `n=${n} seed=${seed} ${p.id} rejoue un adversaire`).toBe(p.opponents.length);
          const d = p.colors.reduce((a, c) => a + (c === "w" ? 1 : c === "b" ? -1 : 0), 0);
          expect(Math.abs(d), `n=${n} seed=${seed} ${p.id} couleurs ${p.colors.join("")}`).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("les meneurs se rencontrent : après 2 rondes sur 8 joueurs, les deux 2/2 jouent ensemble", () => {
    const players: SwissPlayer[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, seed: i + 1, pts2: 0, opponents: [], colors: [], hadBye: false }));
    // p1 et p2 ont 2/2, p3..p6 1/2, p7 p8 0/2
    const pts = [4, 4, 2, 2, 2, 2, 0, 0];
    players.forEach((p, i) => { p.pts2 = pts[i]!; p.colors = i % 2 ? ["b", "w"] : ["w", "b"]; });
    players[0]!.opponents = ["p5", "p3"]; players[1]!.opponents = ["p6", "p4"];
    const pr = pairRound(players, () => 0.3);
    expect(pr.boards[0]!.slice().sort()).toEqual(["p1", "p2"]);
  });
});

describe("système suisse — classement", () => {
  it("points, puis Buchholz, puis Sonneborn-Berger", () => {
    const players = ["a", "b", "c", "d"].map((id, i) => ({ id, seed: i + 1 }));
    const results: SwissResult[] = [
      { white: "a", black: "c", w2: 2 }, { white: "b", black: "d", w2: 2 },
      { white: "b", black: "a", w2: 2 }, { white: "c", black: "d", w2: 1 },
    ];
    const s = swissStandings(players, results, []);
    expect(s.map((r) => r.id)).toEqual(["b", "a", "d", "c"]); // d a joué le vainqueur : meilleur Buchholz
    expect(s[0]).toMatchObject({ pts2: 4, buchholz2: 2 + 1 });
    // c et d : 0,5 pt chacun ; d devant c grâce au Buchholz (d a affronté b, 2 pts ; c a affronté a, 1 pt)
    expect(s.find((r) => r.id === "d")!.buchholz2).toBeGreaterThan(s.find((r) => r.id === "c")!.buchholz2);
  });

  it("rondes conseillées", () => {
    expect(defaultSwissRounds(4)).toBe(3);
    expect(defaultSwissRounds(8)).toBe(4);
    expect(defaultSwissRounds(12)).toBe(5);
    expect(defaultSwissRounds(30)).toBe(6);
    expect(defaultSwissRounds(3)).toBe(2);
  });
});
