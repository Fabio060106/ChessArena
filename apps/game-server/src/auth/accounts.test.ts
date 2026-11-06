import { describe, expect, it } from "vitest";
import { AccountError, AccountService, InMemoryAccountStore, hashPassword, verifyPassword } from "./accounts.js";

const ok = { adult: true, terms: true };
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AccountError ? e.code : String(e)));

describe("comptes joueurs", () => {
  it("hache les mots de passe (sel aléatoire) et les vérifie", async () => {
    const a = await hashPassword("échecs-et-mat");
    const b = await hashPassword("échecs-et-mat");
    expect(a).not.toBe(b);
    expect(a).not.toContain("échecs");
    expect(await verifyPassword("échecs-et-mat", a)).toBe(true);
    expect(await verifyPassword("echecs-et-mat", a)).toBe(false);
  });

  it("inscription puis connexion ; pseudo unique sans tenir compte de la casse", async () => {
    const s = new AccountService(new InMemoryAccountStore());
    expect(await s.signup({ pseudo: "Magnus_06", password: "roque-long-1", flag: "FR", ...ok })).toEqual({ userId: "Magnus_06", flag: "FR" });
    expect(await code(s.signup({ pseudo: "magnus_06", password: "autre-mdp-22", ...ok }))).toBe("PSEUDO_TAKEN");
    expect(await s.login({ pseudo: "magnus_06", password: "roque-long-1" })).toEqual({ userId: "Magnus_06", flag: "FR" });
    expect(await code(s.login({ pseudo: "Magnus_06", password: "mauvais-mdp" }))).toBe("INVALID_CREDENTIALS");
    expect(await code(s.login({ pseudo: "inconnu", password: "roque-long-1" }))).toBe("INVALID_CREDENTIALS");
  });

  it("refuse les entrées invalides et exige l'âge et les conditions", async () => {
    const s = new AccountService(new InMemoryAccountStore());
    expect(await code(s.signup({ pseudo: "ab", password: "12345678", ...ok }))).toBe("BAD_PSEUDO");
    expect(await code(s.signup({ pseudo: "admin", password: "12345678x", ...ok }))).toBe("RESERVED_PSEUDO");
    expect(await code(s.signup({ pseudo: "bobby", password: "court", ...ok }))).toBe("WEAK_PASSWORD");
    expect(await code(s.signup({ pseudo: "bobby", password: "BOBBY", ...ok }))).toBe("WEAK_PASSWORD");
    expect(await code(s.signup({ pseudo: "bobby", password: "12345678x", email: "pas-un-mail", ...ok }))).toBe("BAD_EMAIL");
    expect(await code(s.signup({ pseudo: "bobby", password: "12345678x", adult: false, terms: true }))).toBe("CONSENT_REQUIRED");
  });

  it("un pseudo de la bêta ne se réclame qu'avec le code, une seule fois, avec la même orthographe", async () => {
    const store = new InMemoryAccountStore();
    store.seedBeta("Fabio060106");
    const s = new AccountService(store);
    expect(await code(s.login({ pseudo: "Fabio060106", password: "nimporte-quoi" }))).toBe("NO_PASSWORD_YET");
    expect(await code(s.signup({ pseudo: "Fabio060106", password: "pirate-1234", ...ok }))).toBe("CLAIM_CODE_REQUIRED");
    expect(await code(s.signup({ pseudo: "fabio060106", password: "pirate-1234", betaCodeOk: true, ...ok }))).toBe("PSEUDO_TAKEN");
    expect(await s.signup({ pseudo: "Fabio060106", password: "mon-vrai-mdp", betaCodeOk: true, ...ok })).toMatchObject({ userId: "Fabio060106" });
    expect(await code(s.signup({ pseudo: "Fabio060106", password: "pirate-1234", betaCodeOk: true, ...ok }))).toBe("PSEUDO_TAKEN");
    expect(await s.login({ pseudo: "fabio060106", password: "mon-vrai-mdp" })).toMatchObject({ userId: "Fabio060106" });
  });

  it("bloque les essais en rafale sur un pseudo", async () => {
    const s = new AccountService(new InMemoryAccountStore());
    await s.signup({ pseudo: "cible", password: "bon-mot-de-passe", ...ok });
    for (let i = 0; i < 8; i++) expect(await code(s.login({ pseudo: "cible", password: `essai-${i}` }))).toBe("INVALID_CREDENTIALS");
    expect(await code(s.login({ pseudo: "cible", password: "bon-mot-de-passe" }))).toBe("TOO_MANY_ATTEMPTS");
  });
});
