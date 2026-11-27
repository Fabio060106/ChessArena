import { Chess } from "chess.js";
import type { Color } from "@chessarena/shared";
import { ideaOf, moveFacts } from "./commentary";

/**
 * « Armes secrètes » et « surprises à connaître », préparées hors ligne par scripts/find-weapons.mjs (Stockfish) :
 * des coups rares (hors théorie, ou absents de la base de maîtres) presque aussi bons que le coup principal,
 * avec leur valeur pratique — réponses qui tiennent, réponses naturelles qui perdent (pièges), suite à connaître.
 */

export interface WeaponTrap { reply: string; why: string; eval: number; gain: number; punish: string[] }
export interface Weapon {
  kind: "arme" | "alerte";
  /** camp du répertoire */
  side: Color;
  rep: string; line: string;
  /** coups (SAN) avant la position */
  prefix: string;
  ply: number; fen: string;
  move: string; uci: string;
  /** coup principal du moteur et évaluations (centipions, point de vue du camp qui joue le coup) */
  mainMove: string; mainEval: number; eval: number; cost: number;
  rarity: { kind: "inédit" | "rare" | "hors-livre"; masters?: number; total?: number; name?: string };
  /** évaluation après la meilleure défense, point de vue du camp qui joue le coup */
  bestDefense: string[];
  holding: string[];
  traps: WeaponTrap[];
  /** la meilleure défense n'est pas le premier réflexe */
  hard: boolean;
  /** coup précis à connaître après la meilleure défense (seul bon coup), sinon null */
  precise: string | null;
  score: number;
  repMove: string | null;
}
export interface WeaponsFile { builtAt: string; depth: number; source: "maîtres" | "livre"; reps: Record<string, Weapon[]> }

let loading: Promise<WeaponsFile | null> | null = null;
export function loadWeapons(): Promise<WeaponsFile | null> {
  loading ??= fetch("/weapons.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return loading;
}

/** Les trouvailles d'un répertoire et de ses compléments. */
export function weaponsFor(f: WeaponsFile | null, ids: readonly string[]): Weapon[] {
  if (!f) return [];
  const out: Weapon[] = [];
  for (const id of ids) for (const w of f.reps[id] ?? []) if (!out.some((x) => x.fen === w.fen && x.uci === w.uci && x.kind === w.kind)) out.push(w);
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "arme" ? -1 : 1) || b.score - a.score);
}

const pawns = (cp: number) => (Math.abs(cp) >= 2500 ? (cp > 0 ? "mat" : "mat contre") : `${cp > 0 ? "+" : cp < 0 ? "−" : ""}${(Math.abs(cp) / 100).toFixed(1).replace(".", ",")}`);
/** Évaluation du point de vue des Blancs, à la manière des livres. */
export const evalWhite = (cp: number, mover: Color) => pawns(mover === "w" ? cp : -cp);

/** Numérotation des coups : « 4.Nf3 », « 4…Nf6 ». */
export function numbered(sans: readonly string[], startPly: number): string {
  return sans.map((s, i) => {
    const ply = startPly + i;
    const n = Math.floor(ply / 2) + 1;
    return ply % 2 === 0 ? `${n}.${s}` : i === 0 ? `${n}…${s}` : s;
  }).join(" ");
}

/** Le coup en notation de livre : « 7…Bxf3!? » */
export const moveLabel = (w: Weapon) => `${numbered([w.move], w.ply)}${w.kind === "arme" ? "!?" : "!?"}`;

/** Un SAN joué depuis une position → uci (null si illégal). */
export function uciOf(fen: string, san: string): string | null {
  try { const m = new Chess(fen).move(san); return m.from + m.to + (m.promotion ?? ""); } catch { return null; }
}
export function fenAfter(fen: string, sans: readonly string[]): string | null {
  const c = new Chess(fen);
  try { for (const s of sans) c.move(s); } catch { return null; }
  return c.fen();
}

const RARITY: Record<Weapon["rarity"]["kind"], string> = {
  "inédit": "jamais joué dans la base de maîtres",
  rare: "rarement joué",
  "hors-livre": "absent du livre d'ouvertures",
};
export function rarityText(w: Weapon): string {
  const r = w.rarity;
  if (r.kind === "rare" && r.total) return `joué dans ${r.masters} partie${(r.masters ?? 0) > 1 ? "s" : ""} de maîtres sur ${r.total}`;
  if (r.kind === "rare" && r.name) return `une sous-ligne rare (${r.name.split(":").slice(1).join(":").trim() || r.name})`;
  return RARITY[r.kind];
}

/** Ce qu'un entraîneur dirait de la trouvaille : l'idée, le prix, le problème posé, les pièges, la suite. */
export function weaponCoach(w: Weapon): { title: string; idea: string; verdict: string; problem: string | null; traps: string[]; follow: string } {
  const mover: Color = new Chess(w.fen).turn();
  const f = moveFacts(w.fen, w.uci, w.ply + 1);
  const idea = f ? ideaOf(f, true) : "";
  const after = fenAfter(w.fen, [w.move])!;
  const nextPly = w.ply + 1;
  const title = w.kind === "arme"
    ? `Après ${numbered(w.prefix.split(" "), 0)}, la surprise ${moveLabel(w)}`
    : `Après ${numbered(w.prefix.split(" "), 0)}, attention à ${moveLabel(w)}`;
  const cost = w.cost <= 10 ? "aussi bon que" : w.cost <= 30 ? "presque aussi bon que" : "un peu moins précis que";
  const verdict = `${w.move} est ${rarityText(w)}. Pour Stockfish, il est ${cost} le coup principal ${w.mainMove} (${evalWhite(w.eval, mover)} contre ${evalWhite(w.mainEval, mover)}).`;
  let problem: string | null = null;
  const def = w.bestDefense[0];
  if (w.kind === "arme") {
    if (w.hard && w.holding.length <= 2) problem = `L'adversaire doit trouver ${w.holding.join(" ou ")} : ce n'est pas le premier coup qui vient à l'esprit.`;
    else if (w.holding.length === 1) problem = `Une seule réponse tient : ${w.holding[0]}.`;
    else if (w.traps.length) problem = `Plusieurs réponses tiennent (${w.holding.slice(0, 3).join(", ")}), mais les plus naturelles sont des erreurs.`;
  } else {
    problem = `La bonne réponse : ${numbered([def ?? "?"], nextPly)}${w.holding.length > 1 ? ` (ou ${w.holding.filter((h) => h !== def).slice(0, 2).join(", ")})` : ""}.${w.hard ? " Elle ne saute pas aux yeux : prépare-la à l'avance." : ""}`;
  }
  const traps = w.traps.map((t) => {
    const punish = numbered(t.punish.slice(0, 5), nextPly + 1);
    return `${numbered([t.reply], nextPly)}? (${t.why}) ${punish} et ${w.kind === "arme" ? "tu gagnes" : "l'adversaire gagne"} ${t.eval >= 2500 ? "la partie" : `environ ${(t.gain / 100).toFixed(1).replace(".", ",")} pion${t.gain >= 200 ? "s" : ""}`}.`;
  });
  const follow = `Meilleure défense : ${numbered(w.bestDefense.slice(0, 6), nextPly)}${w.precise ? `. Coup précis à connaître ensuite : ${w.precise}` : ""}. Position finale : ${evalWhite(w.eval, mover)}.`;
  void after;
  return { title, idea, verdict, problem, traps, follow };
}

/** Exercices tirés des trouvailles : trouver l'arme, punir le piège, parer la surprise. */
export interface WeaponExercise { fen: string; answers: string[]; answerSan: string; prompt: string; before: string; why: string }
export function weaponExercises(ws: readonly Weapon[]): WeaponExercise[] {
  const out: WeaponExercise[] = [];
  for (const w of ws) {
    const before = numbered(w.prefix.split(" "), 0);
    const after = fenAfter(w.fen, [w.move]);
    if (!after) continue;
    if (w.kind === "arme") {
      out.push({ fen: w.fen, answers: [w.uci], answerSan: w.move, prompt: "Trouve l'arme secrète : un coup rare mais solide, qui pose des problèmes.", before, why: weaponCoach(w).verdict });
      for (const t of w.traps.slice(0, 1)) {
        const fenT = fenAfter(after, [t.reply]);
        const u = fenT && uciOf(fenT, t.punish[0]!);
        if (fenT && u) out.push({ fen: fenT, answers: [u], answerSan: t.punish[0]!, prompt: `L'adversaire est tombé dans le piège avec ${t.reply}? Punis-le.`, before: `${before} ${numbered([w.move, t.reply], w.ply)}`, why: `${t.punish.slice(0, 5).join(" ")} : environ ${(t.gain / 100).toFixed(1).replace(".", ",")} pion(s) gagnés.` });
      }
    } else {
      const answers = w.holding.map((h) => uciOf(after, h)).filter((x): x is string => !!x);
      if (answers.length) out.push({ fen: after, answers, answerSan: w.holding.join(" ou "), prompt: `Surprise : l'adversaire joue ${w.move}!? Trouve la bonne réponse.`, before: `${before} ${numbered([w.move], w.ply)}`, why: w.traps[0] ? `Attention : ${w.traps[0].reply}? perd (${w.traps[0].punish.slice(0, 3).join(" ")}).` : "" });
    }
  }
  return out;
}
