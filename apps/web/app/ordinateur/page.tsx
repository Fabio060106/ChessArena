"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Color } from "@chessarena/shared";
import { PageHeader } from "../../components/PageHeader";
import { GameBoard } from "../../components/GameBoard";
import { MoveList } from "../../components/MoveList";
import { useMe } from "../../hooks/useMe";
import { analysisLink, BOT_LEVELS, botDelay, botLevel } from "../../lib/bot";
import { Engine } from "../../lib/engine";
import { useSettings } from "../../lib/settings";
import { sound } from "../../lib/sound";
import type { PromotionPiece } from "../../lib/moves";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const LEVEL_KEY = "arena.bot.level";

interface Game { color: Color; level: number; ucis: string[]; sans: string[] }

/** Partie terminée ? Résultat vu par le joueur. */
function outcome(fen: string, me: Color): { title: string; tone: "win" | "loss" | "draw" } | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) return c.turn() === me ? { title: "Échec et mat : l'ordinateur gagne", tone: "loss" } : { title: "Échec et mat : tu gagnes !", tone: "win" };
  if (c.isStalemate()) return { title: "Pat : partie nulle", tone: "draw" };
  if (c.isInsufficientMaterial()) return { title: "Nulle : matériel insuffisant", tone: "draw" };
  if (c.isThreefoldRepetition()) return { title: "Nulle par répétition", tone: "draw" };
  if (c.isDraw()) return { title: "Nulle (règle des 50 coups)", tone: "draw" };
  return null;
}

/**
 * Jouer contre l'ordinateur (Stockfish 19 dans le navigateur, 8 niveaux) : sans pendule, partie non classée,
 * coup repris possible. Pour s'entraîner ou patienter quand personne n'est en ligne.
 */
export default function BotPage() {
  const me = useMe();
  const [settings] = useSettings();
  const [level, setLevel] = useState(3);
  const [pick, setPick] = useState<Color | "random">("random");
  const [game, setGame] = useState<Game | null>(null);
  const [resigned, setResigned] = useState(false);
  const [thinking, setThinking] = useState(false);
  const engine = useRef<Engine | null>(null);
  const gen = useRef(0); // invalide un coup de l'ordinateur arrivé après « reprendre » ou une nouvelle partie

  useEffect(() => {
    try { const v = Number(localStorage.getItem(LEVEL_KEY)); if (v >= 1 && v <= 8) setLevel(v); } catch { /* rien */ }
    return () => { engine.current?.terminate(); engine.current = null; };
  }, []);

  const fen = useMemo(() => {
    const c = new Chess(START);
    for (const u of game?.ucis ?? []) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] as PromotionPiece | undefined });
    return c.fen();
  }, [game?.ucis]);
  const turn: Color = fen.split(" ")[1] === "b" ? "b" : "w";
  const over = game ? (resigned ? { title: "Tu as abandonné", tone: "loss" as const } : outcome(fen, game.color)) : null;
  const myTurn = !!game && !over && turn === game.color && !thinking;

  const botMove = useCallback(async (g: Game, position: string) => {
    const my = ++gen.current;
    if (!engine.current) engine.current = new Engine();
    const lv = botLevel(g.level);
    engine.current.setSkill(lv.skill);
    setThinking(true);
    const started = Date.now();
    const line = await engine.current.analyse(position, lv.depth);
    const wait = botDelay(g.ucis.length) - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (my !== gen.current) return;
    setThinking(false);
    const uci = line?.pv[0];
    if (!uci) return;
    const c = new Chess(position);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as PromotionPiece | undefined) ?? "q" });
    if (!m) return;
    sound.play(m.captured ? "capture" : "move");
    setGame((x) => (x && x === g ? { ...x, ucis: [...x.ucis, m.from + m.to + (m.promotion ?? "")], sans: [...x.sans, m.san] } : x));
  }, []);

  // au tour de l'ordinateur : il joue
  useEffect(() => {
    if (!game || over || turn === game.color || thinking) return;
    void botMove(game, fen);
  }, [game, fen, turn, over, thinking, botMove]);

  const start = () => {
    gen.current++;
    try { localStorage.setItem(LEVEL_KEY, String(level)); } catch { /* rien */ }
    const color: Color = pick === "random" ? (Math.random() < 0.5 ? "w" : "b") : pick;
    setResigned(false); setThinking(false);
    setGame({ color, level, ucis: [], sans: [] });
    sound.play("start");
  };

  const play = (from: string, to: string, promotion?: PromotionPiece): boolean => {
    if (!game || !myTurn) return false;
    const c = new Chess(fen);
    let m;
    try { m = c.move({ from, to, promotion: promotion ?? (settings.autoQueen ? "q" : undefined) }); } catch { return false; }
    if (!m) return false;
    sound.play(m.captured ? "capture" : "move");
    setGame({ ...game, ucis: [...game.ucis, m.from + m.to + (m.promotion ?? "")], sans: [...game.sans, m.san] });
    return true;
  };

  /** Reprendre : revient à mon dernier coup (le mien et la réponse de l'ordinateur). */
  const takeback = () => {
    if (!game || resigned) return;
    gen.current++; setThinking(false);
    const mineLast = (n: number) => (n % 2 === 1) === (game.color === "w"); // demi-coups joués par moi : impairs si Blancs
    let n = game.ucis.length;
    if (n > 0 && !mineLast(n)) n--; // retire la réponse de l'ordinateur
    if (n > 0 && mineLast(n)) n--; // puis mon coup
    setGame({ ...game, ucis: game.ucis.slice(0, n), sans: game.sans.slice(0, n) });
  };

  if (!me) return null;
  const lv = botLevel(game?.level ?? level);
  return (
    <main className="arena-app">
      <PageHeader title="Contre l'ordinateur" active="/ordinateur" />
      <div className="mx-auto grid max-w-[1400px] gap-4 px-2 pb-6 sm:px-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:px-6">
        <section className="mx-auto flex w-full flex-col gap-2" style={{ maxWidth: "min(100%, max(320px, calc(100dvh - 220px)))" }}>
          <p className="flex items-center justify-between px-1 text-sm">
            <span className="font-semibold">🤖 Stockfish · niveau {lv.level} <span className="font-normal text-muted">({lv.label}, ~{lv.elo})</span></span>
            {thinking && <span className="text-xs text-muted">réfléchit…</span>}
          </p>
          <div className="relative">
            <GameBoard fen={fen} serverFen={fen} orientation={game?.color ?? "w"} myColor={game?.color ?? "w"}
              interactive={myTurn} myTurn={myTurn} lastMove={game?.ucis.at(-1) ?? null} premoves={[]}
              theme={settings.boardTheme} pieceSet={settings.pieceSet} palette={settings.palette} coordinates={settings.coordinates}
              autoQueen={settings.autoQueen} onMove={play} onCancelPremoves={() => {}} />
            {over && (
              <div className="absolute inset-0 z-50 grid place-items-center bg-ink/55 backdrop-blur-[2px]">
                <div className="panel w-[min(86%,320px)] p-5 text-center shadow-2xl">
                  <p className={`font-display text-2xl font-bold ${over.tone === "win" ? "text-win" : over.tone === "loss" ? "text-danger" : "text-text"}`}>{over.title}</p>
                  <div className="mt-4 flex flex-col gap-2">
                    <button type="button" onClick={start} className="neon-btn rounded-lg px-3 py-2 font-semibold">Rejouer (niveau {level})</button>
                    {game!.ucis.length > 0 && <a href={analysisLink(game!.ucis)} className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Analyser la partie</a>}
                  </div>
                </div>
              </div>
            )}
          </div>
          <p className="px-1 text-center text-xs text-muted">
            {!game ? "Choisis un niveau et une couleur, puis « Commencer »." : over ? "" : myTurn ? "À toi de jouer." : "L'ordinateur joue…"}
          </p>
        </section>

        <aside className="flex w-full flex-col gap-3">
          <div className="panel flex flex-col gap-3 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Niveau</p>
            <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Niveau de l'ordinateur">
              {BOT_LEVELS.map((x) => (
                <button key={x.level} type="button" aria-pressed={level === x.level} onClick={() => setLevel(x.level)} title={`${x.label} (~${x.elo})`} aria-label={`Niveau ${x.level} : ${x.label}, environ ${x.elo}`}
                  className={`rounded-lg border px-2 py-2 text-sm font-semibold ${level === x.level ? "border-neon/60 bg-neon/10 text-neon" : "border-line text-muted hover:text-text"}`}>
                  {x.level}<span className="block text-[10px] font-normal opacity-80">~{x.elo}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Couleur</p>
            <div className="flex gap-1.5" role="group" aria-label="Ma couleur">
              {([["w", "♔ Blancs"], ["random", "🎲 Au hasard"], ["b", "♚ Noirs"]] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={pick === v} onClick={() => setPick(v)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-sm font-semibold ${pick === v ? "border-neon/60 bg-neon/10 text-neon" : "border-line text-muted hover:text-text"}`}>{label}</button>
              ))}
            </div>
            <button type="button" onClick={start} className="neon-btn rounded-xl px-4 py-2.5 font-semibold">{game && !over ? "Nouvelle partie" : "Commencer"}</button>
            <p className="text-[11px] text-muted">Partie d'entraînement : sans pendule, non classée, coup repris permis. Pour l'Elo, joue contre des humains depuis la page Jouer.</p>
          </div>
          {game && (
            <div className="panel flex flex-col gap-2 p-3">
              <MoveList moves={game.sans} />
              {!over && (
                <div className="flex gap-2">
                  <button type="button" onClick={takeback} disabled={game.ucis.length === 0} className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-50">↶ Reprendre</button>
                  <button type="button" onClick={() => { gen.current++; setThinking(false); setResigned(true); }} className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:border-danger/60 hover:text-danger">Abandonner</button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
