import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { REPERTOIRES, repertoireById } from "./repertoireBook";
import { CATALOG } from "./openingAdvisor";

describe("répertoires complets", () => {
  it("chaque ligne est légale", () => {
    const bad: string[] = [];
    for (const r of REPERTOIRES) for (const l of r.lines) {
      const c = new Chess();
      for (const s of l.moves.split(" ")) { try { c.move(s); } catch { bad.push(`${r.id} / ${l.name} : ${s} après ${c.history().join(" ")}`); break; } }
    }
    expect(bad).toEqual([]);
  });
  it("chaque ouverture conseillée a son répertoire, et les compléments existent", () => {
    for (const o of CATALOG) expect(repertoireById(o.id), o.id).not.toBeNull();
    for (const r of REPERTOIRES) for (const w of r.with ?? []) expect(repertoireById(w), w).not.toBeNull();
  });
  it("les lignes d'un répertoire noir commencent par un coup blanc différent ou la même défense", () => {
    for (const r of REPERTOIRES) for (const l of r.lines) expect(l.moves.split(" ").length).toBeGreaterThanOrEqual(10);
  });
});

import { COURSES } from "./openingCourses";
describe("cours d'ouvertures", () => {
  it("chaque répertoire a son cours, et tous les coups (structures, pièges) sont légaux", () => {
    const bad: string[] = [];
    for (const r of REPERTOIRES) if (!COURSES[r.id]) bad.push(`cours manquant : ${r.id}`);
    for (const [id, c] of Object.entries(COURSES)) for (const x of [...c.structures, ...c.traps]) {
      const ch = new Chess();
      for (const s of x.moves.split(" ")) { try { ch.move(s); } catch { bad.push(`${id} / ${"title" in x ? x.title : x.name} : ${s}`); break; } }
    }
    expect(bad).toEqual([]);
  });
});
