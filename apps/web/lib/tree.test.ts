import { describe, expect, it } from "vitest";
import {
  addUcis, allNodes, branchPoint, isMainline, lineEnd, loadTree, mainline, newTree, parsePgn, promote, remove, saveTree, toPgn, ucisTo, validFen,
} from "./tree";

const san = (t: ReturnType<typeof newTree>, ids: string[]) => ids.map((id) => t.nodes[id]!.san);

describe("arbre d'analyse", () => {
  it("variantes dans les variantes, sans doublon, ligne principale inchangée", () => {
    let t = newTree();
    ({ tree: t } = addUcis(t, t.root, ["e2e4", "e7e5", "g1f3", "b8c6"]));
    const e5 = mainline(t)[2]!;
    let v1: string; let v2: string;
    ({ tree: t, id: v1 } = addUcis(t, e5, ["f1c4", "g8f6"]));          // 2. Fc4 Cf6
    ({ tree: t, id: v2 } = addUcis(t, t.nodes[v1]!.parent!, ["f8c5"])); // 2. Fc4 Fc5 (sous-variante)
    ({ tree: t } = addUcis(t, e5, ["g1f3"]));                            // coup existant : pas de doublon
    expect(san(t, mainline(t).slice(1))).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(t.nodes[e5]!.children.length).toBe(2);
    expect(isMainline(t, v2)).toBe(false);
    expect(san(t, [branchPoint(t, v2)!])).toEqual(["Bc5"]);
    expect(allNodes(t).length).toBe(Object.keys(t.nodes).length);
    expect(toPgn(t)).toBe("1. e4 e5 2. Nf3 (2. Bc4 Nf6 (2... Bc5)) 2... Nc6 *\n");
  });

  it("remonter une variante, supprimer une suite", () => {
    let t = newTree();
    ({ tree: t } = addUcis(t, t.root, ["e2e4", "e7e5"]));
    let d4: string;
    ({ tree: t, id: d4 } = addUcis(t, t.root, ["d2d4", "d7d5"]));
    t = promote(t, d4);
    expect(san(t, mainline(t).slice(1))).toEqual(["d4", "d5"]);
    expect(lineEnd(t, t.root)).toBe(d4);
    const r = remove(t, t.nodes[d4]!.parent!);
    expect(san(r.tree, mainline(r.tree).slice(1))).toEqual(["e4", "e5"]);
    expect(r.id).toBe(t.root);
  });

  it("lit un PGN avec variantes, commentaires et annotations, puis le réécrit", () => {
    const pgn = '[Event "Test"]\n[Result "*"]\n\n1. e4 {bon} e5!? 2. Nf3 (2. f4 exf4 (2... d5) 3. Nf3) 2... Nc6 $1 3. Bb5 a6 *';
    const { tree, headers } = parsePgn(pgn);
    expect(headers.Event).toBe("Test");
    expect(san(tree, mainline(tree).slice(1))).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
    expect(toPgn(tree)).toBe("1. e4 e5 2. Nf3 (2. f4 exf4 (2... d5) 3. Nf3) 2... Nc6 3. Bb5 a6 *\n");
    expect(() => parsePgn("1. e4 e4")).toThrow(/illégal/);
  });

  it("position de départ FEN, sauvegarde compacte et restauration du coup affiché", () => {
    const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
    expect(validFen(fen)).toBe(true);
    expect(validFen("n'importe quoi")).toBe(false);
    let t = newTree(fen);
    let cur: string;
    ({ tree: t } = addUcis(t, t.root, ["e2e4", "e8d7"]));
    ({ tree: t, id: cur } = addUcis(t, mainline(t)[1]!, ["e8f7", "e1f2"]));
    expect(toPgn(t)).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]');
    const back = loadTree(JSON.parse(JSON.stringify(saveTree(t, cur))))!;
    expect(ucisTo(back.tree, back.current)).toEqual(["e2e4", "e8f7", "e1f2"]);
    expect(toPgn(back.tree)).toBe(toPgn(t));
  });
});
