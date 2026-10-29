/** Valeurs fournies par les globalSetup (pgSetup, redisSetup) aux fichiers de test. */
declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    redisUrl: string;
  }
}
export {};
