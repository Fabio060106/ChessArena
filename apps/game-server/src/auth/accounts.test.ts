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

describe("mots de passe : changement et code de réinitialisation", () => {
  it("changer son mot de passe exige l'ancien", async () => {
    const s = new AccountService(new InMemoryAccountStore());
    await s.signup({ pseudo: "papy_jo", password: "ancien-mdp-1", ...ok });
    expect(await code(s.changePassword({ userId: "papy_jo", current: "faux-mdp", next: "nouveau-mdp-2" }))).toBe("INVALID_CREDENTIALS");
    expect(await code(s.changePassword({ userId: "papy_jo", current: "ancien-mdp-1", next: "court" }))).toBe("WEAK_PASSWORD");
    await s.changePassword({ userId: "papy_jo", current: "ancien-mdp-1", next: "nouveau-mdp-2" });
    expect(await code(s.login({ pseudo: "papy_jo", password: "ancien-mdp-1" }))).toBe("INVALID_CREDENTIALS");
    expect((await s.login({ pseudo: "papy_jo", password: "nouveau-mdp-2" })).userId).toBe("papy_jo");
  });

  it("code donné par l'organisateur : casse et tiret indifférents, usage unique, l'ancien code est annulé", async () => {
    const s = new AccountService(new InMemoryAccountStore());
    await s.signup({ pseudo: "Mamie_Lou", password: "oublie-1234", ...ok });
    expect(await code(s.issueResetCode({ target: "personne", by: "Fabio060106" }))).toBe("UNKNOWN_PLAYER");
    const first = await s.issueResetCode({ target: "mamie_lou", by: "Fabio060106" });
    const { code: c, userId } = await s.issueResetCode({ target: "mamie_lou", by: "Fabio060106" });
    expect(userId).toBe("Mamie_Lou");
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(await code(s.resetWithCode({ pseudo: "mamie_lou", code: first.code, password: "tout-neuf-99" }))).toBe("BAD_RESET_CODE");
    expect(await s.resetWithCode({ pseudo: "mamie_lou", code: c.toLowerCase().replace("-", " "), password: "tout-neuf-99" })).toEqual({ userId: "Mamie_Lou", flag: null });
    expect((await s.login({ pseudo: "Mamie_Lou", password: "tout-neuf-99" })).userId).toBe("Mamie_Lou");
    expect(await code(s.resetWithCode({ pseudo: "mamie_lou", code: c, password: "encore-autre-1" }))).toBe("BAD_RESET_CODE");
  });

  it("essais de code limités", async () => {
    const s = new AccountService(new InMemoryAccountStore());
    await s.signup({ pseudo: "cible_x", password: "mdp-solide-1", ...ok });
    await s.issueResetCode({ target: "cible_x", by: "admin" });
    for (let i = 0; i < 5; i++) expect(await code(s.resetWithCode({ pseudo: "cible_x", code: "AAAA-AAAA", password: "pirate-1234" }))).toBe("BAD_RESET_CODE");
    expect(await code(s.resetWithCode({ pseudo: "cible_x", code: "AAAA-AAAA", password: "pirate-1234" }))).toBe("TOO_MANY_ATTEMPTS");
  });
});
