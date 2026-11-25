import { accuracyOf, classify, formatScore, pvToSan, scoreToCp, winPct, type EngineLine, type MoveMark, type Score } from "./engine";

/** Position évaluée : score (point de vue des Blancs) et meilleure suite du moteur. */
export interface PositionEval { score: Score; pv: string[] }

export interface KeyMoment {
  /** demi-coup (1 = premier coup blanc) : position APRÈS ce coup */
  ply: number;
  mover: "w" | "b";
  /** « 23… Txd4 » */
  move: string;
  mark: Exclude<MoveMark, null> | "!";
  /** évaluation avant / après (texte) */
  before: string;
  after: string;
  /** meilleur coup à la place (s'il est différent), et la suite proposée */
  best: string | null;
  line: string | null;
  /** explication en une phrase, pour tous */
  text: string;
  /** perte de chances de gain (0–100) du joueur qui a joué le coup ; négative = coup qui a fait basculer en sa faveur */
  swing: number;
}

export interface GameReview {
  accuracy: { w: number | null; b: number | null };
  counts: { w: Record<"?!" | "?" | "??", number>; b: Record<"?!" | "?" | "??", number> };
  /** chances de gain des Blancs après chaque demi-coup (0 = position de départ) */
  curve: number[];
  moments: KeyMoment[];
  /** résumé en quelques phrases */
  summary: string;
}

const moveLabel = (ply: number, san: string) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "…"} ${san}`;

/**
 * Bilan d'une partie terminée, à partir de l'évaluation de chaque position (fens[i] = après i demi-coups) :
 * précision, erreurs de chaque camp, moments clés (les plus gros basculements) et un résumé lisible.
 */
export function buildReview(p: {
  sans: readonly string[];
  fens: readonly string[];
  evals: readonly PositionEval[];
  names: { w: string; b: string };
  result: string | null;
}): GameReview {
  const cps = p.evals.map((e) => scoreToCp(e.score));
  const counts = { w: { "?!": 0, "?": 0, "??": 0 }, b: { "?!": 0, "?": 0, "??": 0 } };
  const perSide: Record<"w" | "b", Array<{ before: number; after: number; mover: "w" | "b" }>> = { w: [], b: [] };
  const all: KeyMoment[] = [];
  for (let ply = 1; ply < cps.length && ply <= p.sans.length; ply++) {
    const mover: "w" | "b" = ply % 2 === 1 ? "w" : "b";
    const before = cps[ply - 1]!; const after = cps[ply]!;
    perSide[mover].push({ before, after, mover });
    const mark = classify(before, after, mover);
    if (mark) counts[mover][mark]++;
    const loss = mover === "w" ? winPct(before) - winPct(after) : winPct(after) - winPct(before);
    const prev = p.evals[ply - 1]!;
    const bestUci = prev.pv[0] ?? null;
    const played = p.sans[ply - 1]!;
    const bestSan = bestUci ? pvToSan(p.fens[ply - 1]!, [bestUci], 1)[0] ?? null : null;
    const best = bestSan && bestSan !== played ? bestSan : null;
    const line = best ? pvToSan(p.fens[ply - 1]!, prev.pv, 6).join(" ") : null;
    const who = p.names[mover];
    const move = moveLabel(ply, played);
    const b = formatScore(p.evals[ply - 1]!.score); const a = formatScore(p.evals[ply]!.score);
    let text: string;
    if (mark === "??") text = `${who} commet une gaffe : l'évaluation passe de ${b} à ${a}.${best ? ` Il fallait ${best}.` : ""}`;
    else if (mark === "?") text = `Erreur de ${who} (${b} → ${a}).${best ? ` ${best} était plus fort.` : ""}`;
    else if (mark === "?!") text = `Imprécision de ${who} (${b} → ${a}).${best ? ` Mieux : ${best}.` : ""}`;
    else text = `${who} trouve le bon coup.`;
    all.push({ ply, mover, move, mark: mark ?? "!", before: b, after: a, best, line, text, swing: loss });
  }
  // moments clés : les plus grosses erreurs (au plus 5), dans l'ordre de la partie
  const moments = all.filter((m) => m.mark !== "!").sort((x, y) => y.swing - x.swing).slice(0, 5).sort((x, y) => x.ply - y.ply);
  const accuracy = { w: accuracyOf(perSide.w), b: accuracyOf(perSide.b) };
  const curve = cps.map((c) => Math.round(winPct(c) * 10) / 10);
  return { accuracy, counts, curve, moments, summary: summarize(p, accuracy, counts, moments, cps) };
}

function summarize(
  p: { names: { w: string; b: string }; result: string | null; sans: readonly string[] },
  acc: GameReview["accuracy"], counts: GameReview["counts"], moments: KeyMoment[], cps: number[],
): string {
  const out: string[] = [];
  const n = Math.ceil(p.sans.length / 2);
  const res = p.result === "1-0" ? `victoire de ${p.names.w}` : p.result === "0-1" ? `victoire de ${p.names.b}` : p.result === "1/2-1/2" ? "nulle" : "partie terminée";
  out.push(`${res[0]!.toUpperCase()}${res.slice(1)} en ${n} coup${n > 1 ? "s" : ""}.`);
  if (acc.w !== null && acc.b !== null) {
    if (Math.abs(acc.w - acc.b) <= 3) out.push(`Partie très équilibrée en précision (${acc.w} % contre ${acc.b} %).`);
    else {
      const better = acc.w > acc.b ? "w" : "b";
      out.push(`${p.names[better]} a été le plus précis (${acc[better]} % contre ${acc[better === "w" ? "b" : "w"]} %).`);
    }
  }
  const errors = (c: "w" | "b") => counts[c]["??"] + counts[c]["?"];
  if (errors("w") + errors("b") === 0) out.push("Aucune vraie erreur selon Stockfish : une partie de très haut niveau.");
  const worst = moments.slice().sort((x, y) => y.swing - x.swing)[0];
  if (worst && worst.swing >= 20) out.push(`Tournant de la partie : ${worst.move}${worst.mark} (${worst.before} → ${worst.after}).`);
  const maxAdv = cps.reduce((m, c) => (Math.abs(c) > Math.abs(m) ? c : m), 0);
  if (p.result === "1/2-1/2" && Math.abs(maxAdv) >= 150) out.push(`${maxAdv > 0 ? p.names.w : p.names.b} a eu un net avantage (${formatScore({ cp: maxAdv, mate: null })}) sans réussir à le concrétiser.`);
  return out.join(" ");
}

/** Clé de cache : une partie terminée ne change plus. */
export const reviewKey = (relayId: string, round: number | null, index: number, plies: number) => `arena.review.${relayId}.${round ?? 0}.${index}.${plies}`;

export const toEval = (l: EngineLine | null, terminal: Score | null): PositionEval | null =>
  terminal ? { score: terminal, pv: [] } : l ? { score: l.score, pv: l.pv } : null;
