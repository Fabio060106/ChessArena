import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TIME_CONTROLS } from "@chessarena/shared";
import { PgGameRepository } from "../../src/persistence/GameRepository.js";
import { ClubError, PgClubStore, cleanName, slugify } from "../../src/clubs/ClubStore.js";
import { createTestDb, pgAvailable, type TestDb } from "@chessarena/testkit/testDb";

let db: TestDb;
let clubs: PgClubStore;
let repo: PgGameRepository;

describe("clubs — noms et adresses", () => {
  it("adresse lisible, sans accents ; nom contrôlé", () => {
    expect(slugify("Échiquier Club de Port-de-Bouc")).toBe("echiquier-club-de-port-de-bouc");
    expect(slugify("  ♞♞  ")).toBe("club");
    expect(cleanName("  Les   Fous du Roi ")).toBe("Les Fous du Roi");
    expect(() => cleanName("ab")).toThrow(ClubError);
    expect(() => cleanName("<script>")).toThrow(ClubError);
  });
});

describe.skipIf(!pgAvailable())("PgClubStore — clubs en base", () => {
  beforeAll(async () => {
    db = await createTestDb();
    clubs = new PgClubStore(db.pool);
    repo = new PgGameRepository(db.pool);
  });
  afterAll(async () => { await db?.drop(); });

  it("création (fondateur membre), adresse unique, adhésion, Elo des membres, départ", async () => {
    const a = await clubs.create("fabio", "Échiquier de Port-de-Bouc", "Le club du mardi soir");
    expect(a).toMatchObject({ slug: "echiquier-de-port-de-bouc", memberCount: 1, createdBy: "fabio" });
    const b = await clubs.create("jo", "Echiquier de Port de Bouc", "");
    expect(b.slug).toBe("echiquier-de-port-de-bouc-2");
    await clubs.join(a.slug, "marie");
    await expect(clubs.join(a.slug, "marie")).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
    await expect(clubs.join("inconnu", "marie")).rejects.toMatchObject({ code: "UNKNOWN_CLUB" });
    // Elo blitz de marie après une victoire
    await repo.recordGame({
      gameId: randomUUID(), white: { userId: "marie", rating: 0 }, black: { userId: "paul", rating: 0 }, timeControl: TIME_CONTROLS.blitz_3_0,
      stake: { currency: "PLAY", buyInCents: 0 }, result: "1-0", termination: "checkmate", pgn: "", moveTimesMs: [], focusLoss: { w: 0, b: 0 },
      aborted: false, abortedBy: null, rated: true, tournament: null,
    });
    const club = (await clubs.get(a.slug))!;
    expect(club.memberCount).toBe(2);
    expect(club.members.find((m) => m.userId === "marie")).toMatchObject({ role: "member", blitz: 1520, rapid: 1500, games: 1 });
    expect(club.members.find((m) => m.userId === "fabio")).toMatchObject({ role: "owner", blitz: 1500 });
    expect(club.avgBlitz).toBe(1510); // (1520 + 1500) / 2
    // bataille gagnée : premier club de l'instantané final
    await db.pool.query(`INSERT INTO tournaments (id, format, time_control, currency, buy_in_cents, rake_bps, size, payout_structure_bps, status, snapshot, finished_at)
      VALUES ($1, 'arena', 'blitz_3_0', 'PLAY', 0, 1000, 8, '{10000}', 'finished', $2, now())`,
      [randomUUID(), JSON.stringify({ teamBattle: { leaders: 3, teams: [{ slug: a.slug, name: "x", score: 9 }, { slug: b.slug, name: "y", score: 2 }] } })]).catch(async (e) => {
        // schéma minimal différent : on ne teste que ce qui est faisable
        console.warn("insertion de tournoi simplifiée impossible", (e as Error).message);
      });
    expect((await clubs.list(10)).find((c) => c.slug === a.slug)!.battlesWon).toBe(1);
    expect((await clubs.mine("marie")).map((c) => c.slug)).toEqual([a.slug]);
    expect(await clubs.isMember(a.slug, "marie")).toBe(true);
    expect((await clubs.list(10))[0]!.slug).toBe(a.slug); // le plus de membres en tête
    await expect(clubs.leave(a.slug, "fabio")).rejects.toMatchObject({ code: "OWNER_CANNOT_LEAVE" });
    await clubs.leave(a.slug, "marie");
    expect(await clubs.isMember(a.slug, "marie")).toBe(false);
    await expect(clubs.leave(a.slug, "marie")).rejects.toMatchObject({ code: "NOT_MEMBER" });
  });

  it("le fondateur modifie la description ; l'organisateur du site supprime un club (membres en cascade)", async () => {
    const c = await clubs.create("zed", "Club Zed", "");
    await clubs.join(c.slug, "yan");
    await clubs.describe(c.slug, "zed", "Blitz le jeudi");
    expect((await clubs.get(c.slug))!.description).toBe("Blitz le jeudi");
    await expect(clubs.describe(c.slug, "yan", "piraté")).rejects.toMatchObject({ code: "NOT_MEMBER" });
    expect(await clubs.remove(c.slug)).toBe(true);
    expect(await clubs.get(c.slug)).toBeNull();
    expect(await clubs.mine("yan")).toEqual([]);
    expect(await clubs.remove(c.slug)).toBe(false);
  });

  it("2 clubs créés au plus par joueur", async () => {
    await clubs.create("max", "Club Un", "");
    await clubs.create("max", "Club Deux", "");
    await expect(clubs.create("max", "Club Trois", "")).rejects.toMatchObject({ code: "TOO_MANY_CLUBS" });
  });
});
