import { formatScore, pvToSan, scoreToCp, winPct, type EngineLine, type Score } from "./engine";
import { buildReview, type GameReview } from "./gameReview";
import { openingIdea, openingOf } from "./openings";
import { cap, evalWords, ideaOf, isEndgame, moveFacts, NAME, OF_SIDE, opp, pieceList, shortIdea, SIDE, SIDE_CAP, TO_SIDE, VALUE, type MoveFacts } from "./commentary";

/** Version du format (doit correspondre à REVIEW_VERSION côté serveur). */
export const TEACHING_VERSION = 4;

export type TeachMark = "!" | "?!" | "?" | "??" | "";

export interface TeachAlternative { san: string; eval: string; line: string; idea?: string }

export interface TeachMove {
  ply: number;
  san: string;
  mover: "w" | "b";
  mark: TeachMark;
  /** évaluation après le coup (point de vue des Blancs) */
  evalAfter: string;
  /** meilleur coup selon Stockfish à la place (null si c'est le coup joué) */
  best: string | null;
  /** autres coups possibles (2 au plus), avec leur évaluation et la suite */
  alternatives: TeachAlternative[];
  /** commentaire complet (onglet « Coups ») */
  comment: string;
  /** commentaire « de livre » glissé dans la partie après ce coup (null : le coup se lit sans commentaire) */
  note: string | null;
  /** variante entre parenthèses, après la note (ex. « 22… g6! 23. Qd2 Qd8 (−0,3) ») */
  variation: string | null;
  /** coup de la théorie d'ouverture */
  theory: boolean;
  /** quiz : coups acceptés comme bonne réponse (UCI), dans la position d'avant */
  goodUcis: string[];
}

export interface LessonChapter { title: string; text: string; ply: number | null }

export interface TeachingReview extends GameReview {
  version: typeof TEACHING_VERSION;
  opening: string | null;
  moves: TeachMove[];
  /** demi-coups proposés au quiz « trouve le meilleur coup » (erreurs et coups « ! ») */
  quiz: number[];
  /** la partie commentée : une introduction (l'ouverture et ses idées), puis les notes des coups, puis les leçons */
  lesson: { intro: string; chapters: LessonChapter[]; takeaways: string[] };
}

/** Chances de gain (0–100) du joueur `c`. */
const winFor = (s: Score, c: "w" | "b") => { const w = winPct(scoreToCp(s)); return c === "w" ? w : 100 - w; };
const mateFor = (s: Score, c: "w" | "b"): number | null => (s.mate !== null && s.mate !== 0 && (s.mate > 0) === (c === "w") ? Math.abs(s.mate) : null);
const lower = (x: string) => x.replace(/^(Défense|Partie|Ouverture|Gambit|Système)/, (w) => w.toLowerCase());
const num = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "…"}`;

/** Suite numérotée comme dans un livre : « 22… g6 23. Qd2 Qd8 ». `ply` = demi-coup du premier coup de la suite. */
export function numberedLine(fen: string, pv: readonly string[], ply: number, n = 6): string {
  return pvToSan(fen, [...pv], n).map((san, i) => {
    const k = ply + i;
    return i === 0 ? `${num(k)} ${san}` : k % 2 === 1 ? `${num(k)} ${san}` : san;
  }).join(" ");
}

type ErrKind = "allowsMate" | "missedMate" | "hanging" | "fork" | "missedCapture" | "missedTactic" | "positional";

/**
 * Analyse pédagogique d'une partie, façon livre : pour chaque coup son idée (développement, centre, roque, menace,
 * fourchette, colonne ouverte, pion passé…), le verdict de Stockfish, l'explication des erreurs (ce que l'adversaire
 * menace, ce qu'il fallait jouer et pourquoi), l'évolution de la position en mots ; puis un « cours » qui raconte
 * la partie par phases (ouverture, milieu de jeu, finale, tournant) et les leçons à retenir.
 * `lines[i]` = meilleures suites (2 à 3) dans la position après i demi-coups.
 */
export function buildTeaching(p: {
  sans: readonly string[];
  ucis: readonly string[];
  fens: readonly string[];
  lines: ReadonlyArray<readonly EngineLine[]>;
  names: { w: string; b: string };
  result: string | null;
}): TeachingReview {
  const base = buildReview({
    sans: p.sans, fens: p.fens, names: p.names, result: p.result,
    evals: p.lines.map((ls) => ({ score: ls[0]!.score, pv: ls[0]!.pv })),
  });
  const opening = openingOf(p.sans);
  const moves: TeachMove[] = [];
  const kinds = new Map<number, ErrKind>();
  const facts: Array<MoveFacts | null> = [];
  let lastWords = "la position est équilibrée";
  let lastNote = 0;
  // les conseils généraux ne sont donnés qu'une fois par partie
  const said = new Set<string>();
  const moral = (k: string, txt: string) => (said.has(k) ? "" : (said.add(k), txt));
  const castled = { w: false, b: false };
  const endgameAt = p.fens.findIndex((fe, i) => i > 0 && isEndgame(fe));
  for (let ply = 1; ply <= p.sans.length && ply < p.lines.length; ply++) {
    const mover: "w" | "b" = ply % 2 === 1 ? "w" : "b";
    const them = opp(mover);
    const before = p.lines[ply - 1]!; const after = p.lines[ply]!;
    const fenBefore = p.fens[ply - 1]!; const fenAfter = p.fens[ply]!;
    const played = p.ucis[ply - 1]!;
    const san = p.sans[ply - 1]!;
    const best = before[0]!;
    const bestUci = best.pv[0] ?? null;
    const isBest = bestUci === played;
    const loss = Math.max(0, winFor(best.score, mover) - winFor(after[0]!.score, mover));
    const f = moveFacts(fenBefore, played, ply, ply > 1 && p.sans[ply - 2]!.includes("x") ? p.ucis[ply - 2]!.slice(2, 4) : null);
    facts.push(f);
    const bf = bestUci && !isBest ? moveFacts(fenBefore, bestUci, ply, ply > 1 && p.sans[ply - 2]!.includes("x") ? p.ucis[ply - 2]!.slice(2, 4) : null) : null;
    const alternatives: TeachAlternative[] = before
      .filter((l) => l.pv[0] && l.pv[0] !== played)
      .slice(0, 2)
      .map((l) => {
        const af = moveFacts(fenBefore, l.pv[0]!, ply);
        return { san: af?.san ?? l.pv[0]!, eval: formatScore(l.score), line: pvToSan(fenBefore, l.pv, 6).join(" "), idea: af ? shortIdea(af) : "" };
      });
    const theory = ply <= opening.plies;
    let mark: "!" | "?!" | "?" | "??" | "" = loss >= 30 ? "??" : loss >= 20 ? "?" : loss >= 10 ? "?!" : "";
    const idea = f ? ideaOf(f, ply <= 20) : "";
    const parts: string[] = [];
    const words = evalWords(after[0]!.score);

    if (theory && !mark) {
      parts.push(idea || "Un coup de développement classique.");
      if (ply === opening.plies) parts.push(`C'est la position de référence de la ${lower(opening.name ?? "")} ; la suite de la partie sort de la théorie la plus connue.`.replace("de la gambit", "du gambit").replace("de la système", "du système"));
      else parts.push("Coup de théorie.");
    } else if (mark) {
      const label = mark === "??" ? "Une grave erreur" : mark === "?" ? "Une erreur" : "Une imprécision";
      const allows = mateFor(after[0]!.score, them);
      const missed = mateFor(best.score, mover);
      // la réponse de l'adversaire qui punit le coup : prise, fourchette, menace
      const top = winFor(after[0]!.score, them);
      const replies = after.filter((l) => l.pv[0] && winFor(l.score, them) >= top - 10).map((l) => ({ l, f: moveFacts(fenAfter, l.pv[0]!, ply + 1, san.includes("x") ? played.slice(2, 4) : null) }));
      // une prise qui gagne du matériel (pas la simple reprise d'un échange égal)
      const grab = replies.find((r) => r.f?.captured && VALUE[r.f.captured]! >= 1 && !(r.f.recapture && f?.captured && VALUE[f.captured]! >= VALUE[r.f.captured]!)) ?? null;
      const fork = replies.find((r) => (r.f?.targets.filter((t) => t.value >= 3).length ?? 0) >= 2 || (r.f?.check && r.f.targets.some((t) => t.value >= 3))) ?? null;
      let why = "";
      let kind: ErrKind = "positional";
      if (missed && !isBest) {
        kind = "missedMate";
        why = `Il y avait pourtant un mat en ${missed} : ${pvToSan(fenBefore, best.pv, Math.min(2 * missed - 1, 9)).join(" ")}.${moral("mate", " Quand le roi adverse est exposé, il faut d'abord examiner tous les échecs.")}`;
      } else if (allows) {
        kind = "allowsMate";
        why = `Ce coup permet ${TO_SIDE[them]} de mater en ${allows} : ${pvToSan(fenAfter, after[0]!.pv, Math.min(2 * allows - 1, 9)).join(" ")}.`;
      } else if (bf?.captured && VALUE[bf.captured]! >= 3 && !f?.captured) {
        kind = "missedCapture";
        why = `Il y avait du matériel à gagner : ${NAME[bf.captured]} en ${bf.to} pouvait être pris.${moral("punish", " Quand l'adversaire laisse une pièce en prise, il faut le punir tout de suite.")}`;
      } else if (grab?.f && winFor(after[0]!.score, them) >= 60) {
        kind = "hanging";
        why = `${cap(NAME[grab.f.captured!]!)} en ${grab.f.to} n'est plus assez protégé${["q", "r"].includes(grab.f.captured!) ? "e" : ""} : ${grab.f.san} le gagne.${moral("hang", " Avant de jouer, il faut toujours vérifier ce que le coup laisse sans défense.")}`;
      } else if (fork?.f && winFor(after[0]!.score, them) >= 60) {
        kind = "fork";
        why = `Ce coup autorise ${fork.f.san}, ${shortIdea(fork.f) || "un coup double"} : impossible de tout sauver.`;
      } else if (bf && (bf.check || bf.targets.length)) {
        kind = "missedTactic";
      }
      kinds.set(ply, kind);
      parts.push(`${label} ${OF_SIDE[mover]}.`);
      if (idea && kind !== "missedMate") parts.push(`L'idée : ${idea.charAt(0).toLowerCase()}${idea.slice(1)}`);
      if (why) parts.push(why);
      if (bf && kind !== "missedMate") {
        const si = kind === "missedCapture" ? "" : shortIdea(bf);
        const line = best.pv.length > 1 ? ` : ${pvToSan(fenBefore, best.pv, 5).join(" ")}` : "";
        parts.push(`Il fallait jouer ${bf.san}${si ? `, ${si}` : ""} (${formatScore(best.score)})${line}.`);
      }
      if (winFor(best.score, mover) >= 70 && winFor(after[0]!.score, mover) < 60) parts.push(`L'avantage s'envole : ${words}.`);
      else if (words !== lastWords) parts.push(`Désormais, ${words}.`);
    } else if (isBest) {
      const second = before[1];
      const gap = second ? winFor(best.score, mover) - winFor(second.score, mover) : 0;
      if (second && gap >= 15 && ply > opening.plies && !f?.recapture) {
        mark = "!";
        const s2 = moveFacts(fenBefore, second.pv[0] ?? "", ply)?.san;
        parts.push(`Un très bon coup, le seul qui maintient la position. ${idea}`.trim());
        if (s2) parts.push(`Le coup naturel ${s2} n'aurait donné que ${formatScore(second.score)} : il fallait voir plus loin.`);
      } else {
        parts.push(idea || (f?.endgame ? "Un coup de finale précis, qui améliore la position." : "Un coup qui renforce la position."));
        parts.push("C'est aussi le choix de Stockfish.");
      }
      if (words !== lastWords && Math.abs(scoreToCp(after[0]!.score)) >= 90) parts.push(`${cap(words)}.`);
    } else if (loss < 4) {
      const s = bf ? shortIdea(bf) : "";
      const alt = bf ? `${bf.san}${s ? `, ${s},` : ""} était aussi possible.` : "";
      parts.push(idea ? `${idea} Bon coup ; ${alt}`.trim() : `Bon coup. ${alt ? cap(alt) : ""}`.trim());
    } else {
      if (idea) parts.push(idea);
      const s = bf ? shortIdea(bf) : "";
      parts.push(`${idea ? "Correct" : "Un coup jouable"}, mais ${bf?.san ?? "un autre coup"}${s ? `, ${s},` : ""} était un peu plus précis (${formatScore(best.score)}).`);
    }
    // la note « de livre » : seulement là où un commentateur s'arrêterait
    let note: string | null = null;
    let variation: string | null = null;
    if (mark === "??" || mark === "?" || mark === "?!") {
      note = parts.filter((x) => !x.startsWith("Il fallait jouer")).join(" ");
      if (best.pv.length) variation = `${numberedLine(fenBefore, best.pv, ply, 6)}, ${formatScore(best.score)}`;
    } else if (mark === "!") {
      note = parts.join(" ");
    } else if (opening.plies > 0 && ply === opening.plies) {
      note = `${idea ? `${idea} ` : ""}C'est la position de référence de la ${lower(opening.name ?? "")} : la partie quitte maintenant la théorie la plus connue.`.replace("de la gambit", "du gambit").replace("de la système", "du système");
    } else if (ply === endgameAt) {
      note = `${idea ? `${idea} ` : ""}La partie entre en finale : ${SIDE.w} ont ${pieceList(fenAfter, "w")}, ${SIDE.b} ${pieceList(fenAfter, "b")}. ${cap(words)}.`;
    } else if (f && !theory && ((f.castle && !castled[mover]) || f.promotion || f.queenTrade || f.mate
      || (f.targets.filter((t) => t.value >= 3).length >= 2) || (f.check && f.targets.some((t) => t.value >= 3)))) {
      note = idea;
    } else if (f && !theory && idea && ply - lastNote >= 10) {
      note = `${idea}${words !== lastWords || ply - lastNote >= 16 ? ` ${cap(words)}.` : ""}`;
    }
    if (f?.castle) castled[mover] = true;
    if (note) lastNote = ply;
    lastWords = words;
    // bonnes réponses au quiz : les coups qui gardent presque autant de chances que le meilleur
    const goodUcis = before.filter((l) => l.pv[0] && winFor(best.score, mover) - winFor(l.score, mover) < 5).map((l) => l.pv[0]!);
    moves.push({
      ply, san, mover, mark, evalAfter: formatScore(after[0]!.score),
      best: isBest ? null : bf?.san ?? null, alternatives, comment: parts.join(" "), note, variation, theory,
      goodUcis: mark === "!" ? [played] : goodUcis.filter((u) => mark === "" || u !== played),
    });
  }
  // quiz : les plus grosses erreurs (moments clés, 4 au plus) et les « ! » (2 au plus), dans l'ordre de la partie
  const errs = base.moments.map((m) => m.ply).filter((x) => ["??", "?", "?!"].includes(moves[x - 1]?.mark ?? "")).slice(0, 4);
  const greats = moves.filter((m) => m.mark === "!").map((m) => m.ply).slice(0, 2);
  const quiz = [...new Set([...errs, ...greats])].sort((a, b) => a - b);
  const summary = opening.name ? `${opening.name}. ${base.summary}` : base.summary;
  const lesson = buildLesson({ ...p, opening, moves, facts, kinds, moments: base.moments.map((m) => m.ply) });
  return { ...base, version: TEACHING_VERSION, opening: opening.name, moves, quiz, summary, lesson };
}

/** Le « cours » : la partie racontée par phases, comme dans un livre, puis 2 à 4 leçons à retenir. */
function buildLesson(p: {
  sans: readonly string[]; fens: readonly string[]; lines: ReadonlyArray<readonly EngineLine[]>;
  names: { w: string; b: string }; result: string | null;
  opening: { name: string | null; plies: number };
  moves: TeachMove[]; facts: Array<MoveFacts | null>; kinds: Map<number, ErrKind>; moments: number[];
}): TeachingReview["lesson"] {
  const n = p.moves.length;
  const ev = (ply: number) => p.lines[Math.min(ply, p.lines.length - 1)]![0]!.score;
  const who = (c: "w" | "b") => `${p.names[c]} (${SIDE[c]})`;
  const chapters: LessonChapter[] = [];
  if (!n) return { intro: "", chapters, takeaways: [] };

  // limites des phases : fin de l'ouverture (théorie, ou au plus tard au 12e coup), début de la finale
  const endgameAt = p.fens.findIndex((f, i) => i > 0 && isEndgame(f));
  const openEnd = Math.min(n, Math.max(p.opening.plies, Math.min(24, endgameAt > 0 ? endgameAt : 24)));
  const midEnd = endgameAt > 0 ? Math.min(n, endgameAt) : n;

  // 1. l'ouverture
  {
    const castled = (["w", "b"] as const).map((c) => {
      const i = p.facts.findIndex((f) => f?.color === c && f.castle);
      return i >= 0 ? `${SIDE[c]} au coup ${Math.ceil((i + 1) / 2)} (${p.facts[i]!.castle === "k" ? "petit roque" : "grand roque"})` : null;
    });
    const firstOut = p.moves.find((m) => !m.theory);
    const t: string[] = [];
    if (p.opening.name) t.push(`La partie commence par la ${p.opening.name.replace(/^Défense/, "défense").replace(/^Partie/, "partie").replace(/^Ouverture/, "ouverture")}.`.replace("la Gambit", "le gambit").replace("la Système", "le système").replace("la gambit", "le gambit"));
    const idea = openingIdea(p.opening.name);
    if (idea) t.push(idea);
    if (firstOut && p.opening.plies > 0 && firstOut.ply <= openEnd + 2) t.push(`Les joueurs quittent les lignes les plus connues avec ${num(firstOut.ply)} ${firstOut.san}.`);
    const c = castled.filter(Boolean) as string[];
    if (c.length === 2) t.push(`Les deux rois sont mis à l'abri : ${c.join(", ")}.`);
    else if (c.length === 1) t.push(`Seuls ${c[0]} roquent ; l'autre roi reste plus longtemps au centre, ce qui peut devenir un problème si le jeu s'ouvre.`);
    else if (openEnd >= 16) t.push("Aucun des deux rois n'a roqué pendant l'ouverture : les deux camps prennent des risques.");
    const errs = p.moves.slice(0, openEnd).filter((m) => m.mark && m.mark !== "!");
    if (errs.length) t.push(`Une première imprécision apparaît déjà : ${errs.map((m) => `${num(m.ply)} ${m.san}${m.mark}`).slice(0, 2).join(" et ")}.`);
    t.push(`À la sortie de l'ouverture (après ${num(openEnd)} ${p.sans[openEnd - 1]}), ${evalWords(ev(openEnd))}.`);
    chapters.push({ title: "L'ouverture", text: t.join(" "), ply: openEnd });
  }

  // 2. le milieu de jeu
  if (midEnd > openEnd) {
    const t: string[] = [];
    const seg = p.moves.slice(openEnd, midEnd);
    const key = seg.filter((m) => m.mark).sort((a, b) => (b.mark === "??" ? 3 : b.mark === "?" ? 2 : b.mark === "!" ? 1.5 : 1) - (a.mark === "??" ? 3 : a.mark === "?" ? 2 : a.mark === "!" ? 1.5 : 1)).slice(0, 3).sort((a, b) => a.ply - b.ply);
    const themes = new Set<string>();
    for (const f of p.facts.slice(openEnd, midEnd)) {
      if (!f) continue;
      if (f.openFile) themes.add("la lutte pour les colonnes ouvertes");
      if (f.pawnBreak) themes.add("les ruptures de pions");
      if (f.targets.filter((x) => x.value >= 3).length >= 2) themes.add("les coups doubles");
      if (f.check) themes.add("les attaques contre le roi");
    }
    t.push(`Le milieu de jeu commence ; ${evalWords(ev(openEnd))}.`);
    if (themes.size) t.push(`Cette phase tourne autour de ${[...themes].slice(0, 3).join(", ")}.`);
    let prev: TeachMove | null = null;
    for (const m of key) {
      const gift = prev && prev.mark !== "!" && prev.mover !== m.mover && m.ply - prev.ply <= 2 && p.kinds.get(m.ply) === "missedCapture";
      const lead = m.mark === "!" ? `Avec ${num(m.ply)} ${m.san}!, ${who(m.mover)} trouve un coup fort.`
        : gift ? `Mais ${SIDE[m.mover]} ne profitent pas du cadeau : ${num(m.ply)} ${m.san}${m.mark} laisse passer l'occasion.`
        : `${num(m.ply)} ${m.san}${m.mark} : ${m.mark === "??" ? "grave erreur" : m.mark === "?" ? "erreur" : "imprécision"} ${OF_SIDE[m.mover]}.`;
      prev = m;
      const why = gift ? undefined : m.comment.split(". ").find((s) => /n'est plus assez protég|permet|mat en|autorise|matériel à gagner/.test(s));
      t.push(`${lead}${why ? ` ${why.replace(/\.$/, "")}.` : ""}${m.best ? ` Il fallait ${m.best}.` : ""}`);
    }
    if (!key.length) t.push("Les deux joueurs manœuvrent avec précision : aucune erreur notable dans cette phase.");
    t.push(`Au coup ${num(midEnd)}, ${evalWords(ev(midEnd))}.`);
    chapters.push({ title: "Le milieu de jeu", text: t.join(" "), ply: key[0]?.ply ?? openEnd + 1 });
  }

  // 3. la finale
  if (endgameAt > 0 && endgameAt < n) {
    const f0 = p.fens[endgameAt]!;
    const t: string[] = [];
    t.push(`Après ${num(endgameAt)} ${p.sans[endgameAt - 1]}, on entre en finale : ${SIDE.w} ont ${pieceList(f0, "w")}, ${SIDE.b} ${pieceList(f0, "b")}.`);
    t.push(`${cap(evalWords(ev(endgameAt)))}.`);
    const fs = p.facts.slice(endgameAt);
    if (fs.some((f) => f?.kingActive)) t.push("Comme souvent en finale, le roi quitte son abri et devient une pièce active.");
    if (fs.some((f) => f?.passed)) t.push("Les pions passés deviennent l'enjeu principal : chaque case gagnée vers la promotion compte.");
    const errs = p.moves.slice(endgameAt).filter((m) => m.mark && m.mark !== "!");
    if (errs.length) t.push(`En finale aussi, une erreur coûte cher : ${errs.slice(0, 2).map((m) => `${num(m.ply)} ${m.san}${m.mark}`).join(", ")}.`);
    chapters.push({ title: "La finale", text: t.join(" "), ply: endgameAt });
  }

  // 4. le tournant et la conclusion
  {
    // le tournant : la dernière erreur sérieuse du perdant (celle qui décide du résultat), sinon la plus grosse erreur
    const loser: "w" | "b" | null = p.result === "1-0" ? "b" : p.result === "0-1" ? "w" : null;
    const errs = p.moves.filter((m) => m.mark === "??" || m.mark === "?");
    const sev = (m: TeachMove) => (m.mark === "??" ? 3 : m.mark === "?" ? 2 : 1);
    const worst = (loser ? errs.filter((m) => m.mover === loser).at(-1) : undefined)
      ?? p.moments.map((x) => p.moves[x - 1]!).filter((m) => m && m.mark && m.mark !== "!").sort((a, b) => sev(b) - sev(a))[0];
    const t: string[] = [];
    if (worst) {
      t.push(`Le moment décisif est ${num(worst.ply)} ${worst.san}${worst.mark} ${OF_SIDE[worst.mover]}. ${worst.comment.replace(/^(Une grave erreur|Une erreur|Une imprécision) des (Blancs|Noirs)\. /, "")}`);
    }
    const r = p.result;
    if (r === "1-0" || r === "0-1") t.push(`${p.names[r === "1-0" ? "w" : "b"]} remporte la partie (${r}).`);
    else if (r === "½-½" || r === "1/2-1/2") t.push("La partie se termine par la nulle (½-½).");
    if (t.length) chapters.push({ title: worst ? "Le tournant de la partie" : "Conclusion", text: t.join(" "), ply: worst?.ply ?? null });
  }

  // leçons à retenir
  const takeaways: string[] = [];
  const kinds = [...p.kinds.values()];
  const add = (cond: boolean, s: string) => { if (cond && takeaways.length < 4 && !takeaways.includes(s)) takeaways.push(s); };
  add(kinds.includes("hanging"), "Avant chaque coup, regarde quelles pièces deviennent attaquées ou ne sont plus défendues : la plupart des parties se perdent sur une pièce laissée en prise.");
  add(kinds.includes("missedMate") || kinds.includes("allowsMate"), "Cherche d'abord les coups forcés — échecs, prises, menaces — pour toi comme pour l'adversaire : c'est là que se cachent les mats.");
  add(kinds.includes("fork"), "Méfie-toi des pièces placées sur des cases qu'un même cavalier ou une même dame peut attaquer ensemble : c'est la recette des fourchettes.");
  add(kinds.includes("missedCapture") || kinds.includes("missedTactic"), "Quand l'adversaire vient de jouer, demande-toi toujours : « qu'est-ce qui est attaquable maintenant ? » Le meilleur coup était souvent une menace directe.");
  add(p.moves.some((m) => m.mark === "!"), "Dans les positions critiques, le coup naturel n'est pas toujours le bon : compare au moins deux ou trois candidats avant de jouer.");
  add(p.facts.slice(0, 30).some((f) => f?.castle) || p.facts.slice(0, 20).some((f) => f?.develops), "En ouverture : développe les pièces vers le centre, roque tôt, et ne joue pas deux fois la même pièce sans raison.");
  add(endgameAt > 0, "En finale, active ton roi et pousse les pions passés : ce sont les deux idées qui gagnent le plus de finales.");
  add(true, "Rejoue les moments clés dans l'onglet Quiz : trouver soi-même le bon coup est la meilleure façon de progresser.");
  const idea = openingIdea(p.opening.name);
  const intro = p.opening.name
    ? `${p.names.w} (Blancs) contre ${p.names.b} (Noirs). ${cap(lower(p.opening.name))}. ${idea ?? ""}`.trim()
    : `${p.names.w} (Blancs) contre ${p.names.b} (Noirs).`;
  return { intro, chapters, takeaways };
}

/** Texte du quiz pour une position : qui joue, et ce qu'on cherche. */
export function quizPrompt(m: TeachMove, names: { w: string; b: string }): string {
  const who = `${names[m.mover]} (${SIDE[m.mover]})`;
  return m.mark === "!"
    ? `${who} a trouvé ici le seul bon coup. À toi : quel est-il ?`
    : `${who} s'est trompé ici. Trouve un meilleur coup que ${m.san}.`;
}

export { SIDE_CAP };
