import { Chess } from "chess.js";

/**
 * Livre d'ouvertures : les 3 865 positions nommées de la base libre lichess-org/chess-openings (CC0).
 * Il donne le nom exact d'une variante (transpositions comprises), les sous-lignes connues
 * depuis une position, et le moment où une partie quitte la théorie répertoriée.
 */

export interface BookEntry { eco: string; name: string; plies: number }
export interface BookBranch { san: string; uci: string; eco: string; name: string }
export interface BookPly {
  ply: number;
  /** position après ce demi-coup répertoriée (nommée) dans le livre */
  entry: BookEntry | null;
  /** autres coups répertoriés depuis la position d'avant (sans le coup joué) */
  alternatives: BookBranch[];
}
export interface BookTrace {
  plies: BookPly[];
  /** la variante la plus précise atteinte */
  deepest: (BookEntry & { ply: number }) | null;
  /** premier demi-coup hors du livre (null si toute la partie y reste) */
  leftAt: number | null;
}

const MAJOR = /^(Ruy Lopez|Italian Game|Scotch Game|Four Knights Game|Petrov's Defense|Sicilian Defense|French Defense|Caro-Kann Defense|Queen's Gambit|Slav Defense|Semi-Slav Defense|Nimzo-Indian Defense|Queen's Indian Defense|King's Indian Defense|Grünfeld Defense|Catalan Opening|English Opening|Réti Opening|London System|Dutch Defense|Pirc Defense|Modern Defense|Scandinavian Defense|Alekhine Defense|Vienna Game|King's Gambit|Philidor Defense|Benoni Defense|Benko Gambit|Bogo-Indian Defense|Trompowsky Attack|Zukertort Opening|Nimzo-Larsen Attack|Bird Opening|King's Pawn Game|Queen's Pawn Game|Indian Defense|Center Game|Tarrasch Defense|King's Knight Opening|Three Knights Opening|Bishop's Opening|Ponziani Opening)\b/;
const OFFBEAT = /Bongcloud|K[aá]das|Anderssen'?s Opening|MacLeod|Alapin Opening|Napoleon|Tortoise|Mengarini|Busch-Gass|Damiano|McConnell|Jalalabad|Whale|Tayler|Dresden|Amar|Grob|Ware|Irish|Halloween|Gunderam|Duras|Wormald|Noah's Ark|Trap|Fried Fox|Toilet|Hippopotamus|Barnes|Sodium|Clemenz|Saragossa|Durkin|Kadas|Van Geet|Mieses|Anderssen Opening|Borg|Carr|St\. George|Englund|Fishing Pole|Fool's|Blumenfeld Countergambit Accepted|Kangaroo|Crab|Creepy Crawly|Pterodactyl|Rat|Lion|Cow|Monkey|Orangutan|Sokolsky|Polish/i;
let SERIOUS: RegExp | null = null;
/** Les sous-variantes reconnues au haut niveau (celles dont on connaît l'idée) passent en premier. */
export function setSeriousLines(prefixes: readonly string[]) {
  SERIOUS = new RegExp(`^(${prefixes.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
}
function rank(name: string): number {
  if (OFFBEAT.test(name)) return 3;
  if (SERIOUS?.test(name)) return 0;
  return MAJOR.test(name) ? 1 : 2;
}

export const epdOf = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

export class OpeningBook {
  private readonly map = new Map<string, BookEntry>();
  constructor(rows: ReadonlyArray<readonly [string, string, string, number]>) {
    for (const [epd, eco, name, plies] of rows) this.map.set(epd, { eco, name, plies });
  }
  get size() { return this.map.size; }

  lookup(fen: string): BookEntry | null { return this.map.get(epdOf(fen)) ?? null; }

  /** Coups qui mènent à une position nommée du livre. */
  branches(fen: string): BookBranch[] {
    let c: Chess;
    try { c = new Chess(fen); } catch { return []; }
    const out: BookBranch[] = [];
    for (const m of c.moves({ verbose: true })) {
      c.move(m);
      const e = this.map.get(epdOf(c.fen()));
      c.undo();
      if (e) out.push({ san: m.san, uci: m.from + m.to + (m.promotion ?? ""), eco: e.eco, name: e.name });
    }
    // d'abord les sous-variantes sérieuses (connues au haut niveau), puis les grandes familles, les curiosités en dernier
    return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.split(",").length - b.name.split(",").length || a.name.length - b.name.length);
  }

  /** Les sous-lignes qui comptent : variantes sérieuses et grandes familles (les curiosités seulement s'il n'y a rien d'autre). */
  mainBranches(fen: string): BookBranch[] {
    const all = this.branches(fen);
    const main = all.filter((b) => rank(b.name) <= 1);
    return main.length ? main : all.filter((b) => rank(b.name) === 2).slice(0, 2);
  }

  /** Suit une partie dans le livre. `fens[i]` = position après i demi-coups ; `ucis[i]` = coup i+1. */
  trace(fens: readonly string[], ucis: readonly string[]): BookTrace {
    const plies: BookPly[] = [];
    let deepest: BookTrace["deepest"] = null;
    let leftAt: number | null = null;
    let miss = 0;
    for (let i = 1; i < fens.length; i++) {
      const entry = this.lookup(fens[i]!);
      const alternatives = this.mainBranches(fens[i - 1]!).filter((b) => b.uci !== ucis[i - 1]);
      plies.push({ ply: i, entry, alternatives });
      if (entry) { deepest = { ...entry, ply: i }; miss = 0; }
      else if (++miss >= 4 || i > 60) { leftAt ??= deepest ? deepest.ply + 1 : 1; break; }
    }
    if (leftAt === null && deepest && deepest.ply < fens.length - 1) leftAt = deepest.ply + 1;
    return { plies: plies.slice(0, leftAt ?? plies.length), deepest, leftAt };
  }
}

let loading: Promise<OpeningBook | null> | null = null;
/** Charge le livre (une seule fois, ~70 Ko compressé). */
export function loadOpeningBook(): Promise<OpeningBook | null> {
  loading ??= fetch("/opening-book.json")
    .then(async (r) => (r.ok ? new OpeningBook((await r.json()) as Array<[string, string, string, number]>) : null))
    .catch(() => null);
  return loading;
}

/** Familles d'ouvertures : nom anglais du livre → nom français. Le reste du nom (sous-variante) garde son nom international. */
const FAMILY: Array<[string, string]> = [
  ["Ruy Lopez", "Partie espagnole"], ["Italian Game", "Partie italienne"], ["Scotch Game", "Partie écossaise"],
  ["Four Knights Game", "Partie des quatre cavaliers"], ["Three Knights Opening", "Partie des trois cavaliers"],
  ["Petrov's Defense", "Défense russe (Petrov)"], ["Russian Game", "Défense russe (Petrov)"], ["Philidor Defense", "Défense Philidor"],
  ["King's Gambit Accepted", "Gambit du roi accepté"], ["King's Gambit Declined", "Gambit du roi refusé"], ["King's Gambit", "Gambit du roi"],
  ["Vienna Game", "Partie viennoise"], ["Bishop's Opening", "Ouverture du fou"], ["Center Game", "Partie du centre"],
  ["Danish Gambit", "Gambit danois"], ["Ponziani Opening", "Ouverture Ponziani"], ["King's Pawn Game", "Partie du pion roi"],
  ["Sicilian Defense", "Défense sicilienne"], ["French Defense", "Défense française"], ["Caro-Kann Defense", "Défense Caro-Kann"],
  ["Scandinavian Defense", "Défense scandinave"], ["Pirc Defense", "Défense Pirc"], ["Modern Defense", "Défense moderne"],
  ["Alekhine Defense", "Défense Alekhine"], ["Owen Defense", "Défense Owen"], ["Nimzowitsch Defense", "Défense Nimzowitsch"],
  ["Queen's Gambit Declined", "Gambit dame refusé"], ["Queen's Gambit Accepted", "Gambit dame accepté"], ["Queen's Gambit", "Gambit dame"],
  ["Semi-Slav Defense", "Défense semi-slave"], ["Slav Defense", "Défense slave"], ["Tarrasch Defense", "Défense Tarrasch"],
  ["Nimzo-Indian Defense", "Défense nimzo-indienne"], ["Queen's Indian Defense", "Défense ouest-indienne"], ["Bogo-Indian Defense", "Défense bogo-indienne"],
  ["King's Indian Defense", "Défense est-indienne"], ["King's Indian Attack", "Attaque est-indienne"], ["Grünfeld Defense", "Défense Grünfeld"],
  ["Catalan Opening", "Ouverture catalane"], ["Benoni Defense", "Défense Benoni"], ["Benko Gambit", "Gambit Benko"],
  ["Dutch Defense", "Défense hollandaise"], ["London System", "Système de Londres"], ["Trompowsky Attack", "Attaque Trompowsky"],
  ["Queen's Pawn Game", "Partie du pion dame"], ["Indian Defense", "Défense indienne"], ["English Opening", "Ouverture anglaise"],
  ["Réti Opening", "Ouverture Réti"], ["Zukertort Opening", "Ouverture Zukertort"], ["Nimzo-Larsen Attack", "Attaque Nimzo-Larsen"],
  ["Bird Opening", "Ouverture Bird"], ["Polish Opening", "Ouverture polonaise"], ["Hungarian Opening", "Ouverture hongroise"],
  ["Elephant Gambit", "Gambit de l'éléphant"], ["Latvian Gambit", "Gambit letton"], ["Englund Gambit", "Gambit Englund"],
  ["Budapest Defense", "Défense Budapest"], ["Old Indian Defense", "Défense vieille-indienne"], ["Torre Attack", "Attaque Torre"],
  ["Colle System", "Système Colle"], ["King's Knight Opening", "Ouverture du cavalier roi"], ["Blackmar-Diemer Gambit", "Gambit Blackmar-Diemer"], ["Richter-Veresov Attack", "Attaque Richter-Veresov"],
];

/** « Ruy Lopez: Berlin Defense, Rio Gambit » → « Partie espagnole : Berlin Defense, Rio Gambit » */
export function frenchOpening(name: string): string {
  const [fam, ...rest] = name.split(":");
  const f = FAMILY.find(([en]) => fam!.trim() === en)?.[1] ?? fam!.trim();
  return rest.length ? `${f} : ${rest.join(":").trim()}` : f;
}

/** Famille seule (« Partie espagnole »). */
export const familyOf = (name: string) => frenchOpening(name.split(":")[0]!);
