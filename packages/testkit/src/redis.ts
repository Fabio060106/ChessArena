import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import "./context.js";

export const redisAvailable = (): boolean => !!inject("redisUrl");

/** URL Redis + préfixe de clés unique : les fichiers de test tournent en parallèle sur le même serveur. */
export function testRedis(): { url: string; prefix: string } {
  return { url: inject("redisUrl"), prefix: `t${randomBytes(4).toString("hex")}` };
}
