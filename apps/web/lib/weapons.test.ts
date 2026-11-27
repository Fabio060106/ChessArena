import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { numbered, weaponCoach, weaponExercises, weaponsFor, type Weapon, type WeaponsFile } from "./weapons";

const fenAt = (s: string) => { const c = new Chess(); for (const m of s.split(" ")) c.move(m); return c.fen(); };
// 1.e4 e5 2.Nf3 Nc6 3.Bc4 : l'arme 3…Nd4!? (piège de Blackburne) — 4.Nxe5? Qg5! 
const arme: Weapon = {
  kind: "arme", side: "b", rep: "e5", line: "Italienne", prefix: "e4 e5 Nf3 Nc6 Bc4", ply: 5, fen: fenAt("e4 e5 Nf3 Nc6 Bc4"),
  move: "Nd4", uci: "c6d4", mainMove: "Nf6", mainEval: -20, eval: -45, cost: 25, rarity: { kind: "rare", name: "Italian Game: Blackburne-Kostić Gambit" },
  bestDefense: ["Nxd4", "exd4", "c3"], holding: ["Nxd4", "O-O", "c3"], traps: [{ reply: "Nxe5", why: "prise tentante", eval: 400, gain: 445, punish: ["Qg5", "Nxf7", "Qxg2", "Rf1", "Qxe4+"] }],
  hard: false, precise: null, score: 62, repMove: "Nf6",
};
const alerte: Weapon = {
  ...arme, kind: "alerte", side: "w", prefix: "e4 e5 Nf3 Nc6 Bc4", move: "Nd4", traps: [], holding: ["Nxd4"], bestDefense: ["Nxd4", "exd4"], hard: true, score: 40,
};

describe("armes secrètes", () => {
  it("numérote les coups comme un livre", () => {
    expect(numbered(["e4", "e5", "Nf3"], 0)).toBe("1.e4 e5 2.Nf3");
    expect(numbered(["Nd4", "Nxe5"], 5)).toBe("3…Nd4 4.Nxe5");
  });
  it("explique l'arme comme un entraîneur : rareté, prix, piège, suite", () => {
    const c = weaponCoach(arme);
    expect(c.title).toBe("Après 1.e4 e5 2.Nf3 Nc6 3.Bc4, la surprise 3…Nd4!?");
    expect(c.verdict).toMatch(/^Nd4 est une sous-ligne rare \(Blackburne-Kostić Gambit\)\. Pour Stockfish, il est presque aussi bon que le coup principal Nf6 \(\+0,5 contre \+0,2\)/);
    expect(c.traps[0]).toBe("4.Nxe5? (prise tentante) 4…Qg5 5.Nxf7 Qxg2 6.Rf1 Qxe4+ et tu gagnes environ 4,5 pions.");
    expect(c.follow).toMatch(/^Meilleure défense : 4\.Nxd4 exd4 5\.c3/);
  });
  it("donne l'antidote d'une surprise adverse", () => {
    expect(weaponCoach(alerte).problem).toMatch(/^La bonne réponse : 4\.Nxd4\. Elle ne saute pas aux yeux/);
  });
  it("en tire des exercices jouables", () => {
    const ex = weaponExercises([arme, alerte]);
    expect(ex.map((e) => e.answerSan)).toEqual(["Nd4", "Qg5", "Nxd4"]);
    expect(ex[0]!.answers).toEqual(["c6d4"]);
    expect(ex[1]!.answers).toEqual(["d8g5"]);
    expect(ex[2]!.answers).toEqual(["f3d4"]);
  });
  it("regroupe les trouvailles d'un répertoire et de ses compléments, armes d'abord", () => {
    const f: WeaponsFile = { builtAt: "", depth: 16, source: "livre", reps: { a: [alerte], b: [arme, { ...arme }] } };
    expect(weaponsFor(f, ["a", "b"]).map((w) => w.kind)).toEqual(["arme", "alerte"]);
    expect(weaponsFor(null, ["a"])).toEqual([]);
  });
});
