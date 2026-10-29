import { describe, expect, it } from "vitest";
import { CidrGeoResolver, CidrSet, clientOrigin, decideSessionMode, KillSwitch, parseCidr, parseIp, unknownGeoResolver } from "./geoFilter.js";
import { NullAuditLog } from "../audit/auditLog.js";

describe("adresses IP", () => {
  it("IPv4, IPv6 compressée, IPv4-mappée, port et zone", () => {
    expect(parseIp("192.0.2.1")).toEqual({ v: 4, n: 0xc0000201n });
    expect(parseIp("::ffff:192.0.2.1")).toEqual({ v: 4, n: 0xc0000201n });
    expect(parseIp("2001:db8::1")).toEqual({ v: 6, n: 0x20010db8000000000000000000000001n });
    expect(parseIp("[2001:db8::1]:443")?.v).toBe(6);
    expect(parseIp("fe80::1%eth0")?.v).toBe(6);
    expect(parseIp("::1")).toEqual({ v: 6, n: 1n });
    for (const bad of ["", "999.1.1.1", "1.2.3", "abc", "2001:db8:::1", "1.2.3.4; DROP"]) expect(parseIp(bad)).toBeNull();
  });
  it("CIDR", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ v: 4, start: 0x0a000000n, end: 0x0affffffn });
    expect(parseCidr("10.1.2.3/8")!.start).toBe(0x0a000000n);        // bits d'hôte ignorés
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    const s = new CidrSet(["10.0.0.0/8", "2001:db8::/32"]);
    expect(s.has("10.200.0.1")).toBe(true);
    expect(s.has("11.0.0.1")).toBe(false);
    expect(s.has("2001:db8:ffff::1")).toBe(true);
    expect(() => new CidrSet(["nope"])).toThrow();
  });
});

describe("résolveur CIDR → pays", () => {
  const csv = "network,country_iso_code\n2.0.0.0/12,FR\n5.0.0.0/16,MT\n8.8.8.0/24,US\n2a01:e00::/26,FR\n\"9.9.9.0/24\",\"ch\"\nbroken\n";
  const r = CidrGeoResolver.fromCsv(csv);
  it("recherche dichotomique v4 / v6, bords inclus, trous = inconnu", () => {
    expect(r.size).toBe(5);
    expect(r.lookup("2.0.0.0")).toBe("FR");
    expect(r.lookup("2.15.255.255")).toBe("FR");
    expect(r.lookup("2.16.0.0")).toBeNull();
    expect(r.lookup("5.0.10.10")).toBe("MT");
    expect(r.lookup("9.9.9.9")).toBe("CH");
    expect(r.lookup("2a01:e00::42")).toBe("FR");
    expect(r.lookup("2a01:f00::1")).toBeNull();
    expect(r.lookup("::ffff:8.8.8.8")).toBe("US");
    expect(r.lookup("pas-une-ip")).toBeNull();
  });
  it("100 000 recherches sur 50 000 blocs en < 500 ms", () => {
    const big = new CidrGeoResolver(Array.from({ length: 50_000 }, (_, i) => [`${(i >> 8) & 255}.${i & 255}.0.0/16`, i % 2 ? "FR" : "DE"] as [string, string]));
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) big.lookup(`${i & 255}.${(i >> 3) & 255}.1.1`);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("origine du client — anti-usurpation (OWASP)", () => {
  const resolver = CidrGeoResolver.fromCsv("5.0.0.0/16,MT\n8.8.8.0/24,US\n10.0.0.0/8,ZZ");
  const opts = { trustedProxies: new CidrSet(["10.0.0.0/8"]), resolver, edgeCountryHeader: "cf-ipcountry" };

  it("connexion directe : X-Forwarded-For et en-tête pays IGNORÉS", () => {
    const o = clientOrigin("8.8.8.8", { "x-forwarded-for": "5.0.0.1", "cf-ipcountry": "MT" }, opts);
    expect(o).toEqual({ ip: "8.8.8.8", country: "US", source: "geo-db" });
  });
  it("via proxy de confiance : premier saut non fiable en partant de la droite", () => {
    // le client a forgé « 5.0.0.1 » à gauche ; le LB a ajouté son IP réelle 8.8.8.8
    const o = clientOrigin("10.0.0.2", { "x-forwarded-for": "5.0.0.1, 8.8.8.8, 10.0.0.9" }, { ...opts, edgeCountryHeader: "" });
    expect(o.ip).toBe("8.8.8.8");
    expect(o.country).toBe("US");
  });
  it("en-tête pays de l'edge accepté seulement depuis un proxy ; XX / Tor = inconnu", () => {
    expect(clientOrigin("10.0.0.2", { "x-forwarded-for": "8.8.8.8", "cf-ipcountry": "mt" }, opts)).toMatchObject({ country: "MT", source: "edge-header" });
    expect(clientOrigin("10.0.0.2", { "x-forwarded-for": "8.8.8.8", "cf-ipcountry": "T1" }, opts)).toMatchObject({ country: "US", source: "geo-db" });
  });
  it("XFF mal formé : on s'arrête au dernier saut sûr", () => {
    expect(clientOrigin("10.0.0.2", { "x-forwarded-for": "<script>, 10.0.0.3" }, { ...opts, edgeCountryHeader: "" }).ip).toBe("10.0.0.3");
  });
  it("aucune base : pays inconnu", () => {
    expect(clientOrigin("8.8.8.8", {}, { ...opts, resolver: unknownGeoResolver })).toEqual({ ip: "8.8.8.8", country: null, source: "none" });
  });
});

describe("décision du mode de session", () => {
  const on = { enabled: true, countries: ["MT"] };
  const base = { killSwitch: on, ipCountry: "MT", residenceCountry: "MT", selfExcluded: false };
  it.each([
    [{}, "REAL_MONEY", "OK"],
    [{ residenceCountry: null }, "REAL_MONEY", "OK"],
    [{ killSwitch: { enabled: false, countries: ["MT"] } }, "PLAY_MONEY_ONLY", "REAL_MONEY_DISABLED"],
    [{ ipCountry: null }, "PLAY_MONEY_ONLY", "UNKNOWN_LOCATION"],
    [{ ipCountry: "FR" }, "PLAY_MONEY_ONLY", "JURISDICTION_BLOCKED"],
    [{ residenceCountry: "FR" }, "PLAY_MONEY_ONLY", "RESIDENCE_BLOCKED"],
    [{ selfExcluded: true, killSwitch: { enabled: false, countries: [] } }, "LOCKED", "SELF_EXCLUDED"],
  ] as const)("%o → %s (%s)", (over, mode, reason) => {
    expect(decideSessionMode({ ...base, ...over })).toEqual({ mode, reason });
  });
});

describe("kill-switch (sans base)", () => {
  it("pays effectifs = consigne ∩ plafond d'environnement ; ENV=0 l'emporte toujours", async () => {
    const ks = new KillSwitch(null, new NullAuditLog(), { envEnabled: true, envCountries: ["MT", "FR"] });
    await ks.set("agent", { enabled: true, countries: ["MT", "US"] }, "ouverture Malte");
    expect(await ks.state()).toMatchObject({ enabled: true, countries: ["MT"] });   // US hors plafond
    const off = new KillSwitch(null, undefined, { envEnabled: false, envCountries: ["MT"] });
    await off.set("agent", { enabled: true, countries: ["MT"] }, "tentative");
    expect((await off.state()).enabled).toBe(false);
  });
  it("motif obligatoire, codes pays validés, écouteurs notifiés une fois par changement", async () => {
    const audit = new NullAuditLog();
    const ks = new KillSwitch(null, audit, { envEnabled: true, envCountries: ["MT"] });
    const seen: boolean[] = [];
    ks.onChange((s) => { seen.push(s.enabled); });
    await ks.state();
    await expect(ks.set("a", { enabled: false }, "")).rejects.toThrow(/motif/);
    await expect(ks.set("a", { enabled: true, countries: ["France"] }, "ouverture")).rejects.toThrow(/ISO/);
    await ks.set("a", { enabled: false }, "incident PSP");
    await ks.set("a", { enabled: false }, "incident PSP (doublon)");
    await ks.set("a", { enabled: true }, "fin d'incident");
    expect(seen).toEqual([false, true]);
    expect(audit.entries.filter((e) => e.type === "compliance.killswitch")).toHaveLength(3);
  });
});
