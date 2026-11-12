import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@chessarena/shared";
import { mergeChat } from "./chat";
import { pct } from "./social";

const msg = (id: number, text = `m${id}`): ChatMessage => ({ id, gameId: "g", channel: "players", userId: "ana", text, at: id });

describe("chat côté client", () => {
  it("fusionne direct et historique sans doublon, dans l'ordre du serveur, 100 messages au plus", () => {
    expect(mergeChat([msg(3), msg(1)], [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3]);
    const many = Array.from({ length: 150 }, (_, i) => msg(i + 1));
    const out = mergeChat([], many);
    expect(out).toHaveLength(100);
    expect(out[0]!.id).toBe(51);
  });
  it("pourcentages du bilan", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBe(0);
  });
});
