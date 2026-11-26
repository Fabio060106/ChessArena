import { describe, expect, it } from "vitest";
import { matchScore, nextRound, points, shortName, untilText } from "./relayFormat";

describe("affichage des retransmissions", () => {
  it("points et noms courts", () => {
    expect([points(0), points(0.5), points(1.5), points(7)]).toEqual(["0", "½", "1½", "7"]);
    expect(shortName("Sindarov, Javokhir")).toBe("Sindarov");
    expect(shortName("Gukesh D")).toBe("Gukesh");
    expect(shortName("Magnus Carlsen")).toBe("Magnus Carlsen");
  });
  it("score du match et prochaine partie", () => {
    expect(matchScore([{ name: "Sindarov, Javokhir", title: "GM", score: 1.5, played: 2 }, { name: "Gukesh D", title: "GM", score: 0.5, played: 2 }])?.text)
      .toBe("Sindarov 1½ – ½ Gukesh");
    expect(matchScore([])).toBeNull();
    const now = 1_000_000_000;
    expect(nextRound([{ number: 1, name: "Game 1", state: "finished" }, { number: 3, name: "Game 3", state: "upcoming", startsAt: now + 7_200_000 }, { number: 2, name: "Game 2", state: "upcoming", startsAt: now + 3_600_000 }], now)?.name).toBe("Game 2");
    expect(untilText(now + 8_100_000, now)).toBe("dans 2 h 15");
    expect(untilText(now + 300_000, now)).toBe("dans 5 min");
  });
});
