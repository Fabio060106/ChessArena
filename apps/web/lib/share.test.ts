import { describe, expect, it } from "vitest";
import { shareTargets, whatsappUrl } from "./share";

describe("partage par messagerie", () => {
  const url = "https://chess-arena-97af.vercel.app/defi/abcd2345";
  it("Telegram, Snapchat, SMS, e-mail, X ; Messenger seulement sur téléphone ; adresses encodées", () => {
    const d = shareTargets("Je te défie aux échecs", url, false);
    expect(d.map((x) => x.id)).toEqual(["telegram", "snapchat", "sms", "email", "x"]);
    expect(shareTargets("x", url, true).map((x) => x.id)).toContain("messenger");
    expect(d.find((x) => x.id === "telegram")!.href).toBe(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=Je%20te%20d%C3%A9fie%20aux%20%C3%A9checs`);
    expect(d.find((x) => x.id === "sms")!.href).toContain(encodeURIComponent(url));
    expect(whatsappUrl(`Salut ${url}`)).toBe(`https://wa.me/?text=Salut%20${encodeURIComponent(url)}`);
  });
});
