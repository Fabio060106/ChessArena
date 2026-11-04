"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Color } from "@chessarena/shared";
import { BOARD_THEMES, type BoardThemeId } from "../lib/boardThemes";
import {
  FILES, checkedKing, isPromotion, legalTargets, premoveDests, reconcileSprites, squareToXY, uciToSquares, virtualBoard,
  xyToSquare, type PieceCode, type PieceSprite, type Premove, type PromotionPiece,
} from "../lib/moves";
import { sound } from "../lib/sound";
import { PieceDefs, PieceSvg, PIECE_NAMES } from "./Pieces";

interface Props {
  /** position affichée (inclut un coup optimiste en attente d'ack) */
  fen: string;
  /** dernière position confirmée par le serveur (cibles légales, promotions) */
  serverFen: string;
  orientation: Color;
  myColor: Color;
  interactive: boolean;
  /** au joueur de jouer ET aucun coup en attente */
  myTurn: boolean;
  lastMove: string | null;
  premoves: readonly Premove[];
  theme: BoardThemeId;
  coordinates: boolean;
  /** true = coup joué ou pré-move ajouté */
  onMove: (from: string, to: string, promotion?: PromotionPiece) => boolean;
  onCancelPremoves: () => void;
  /** flèches d'analyse (relecture uniquement), ex. meilleur coup du moteur */
  arrows?: ReadonlyArray<{ from: string; to: string; color?: string }>;
}

/** Une case = 12,5 % du plateau ; translate en % de l'élément lui-même → (x, y) cases. */
const sqTransform = (sq: string, o: Color) => {
  const { x, y } = squareToXY(sq, o);
  return `translate3d(${x * 100}%, ${y * 100}%, 0)`;
};

interface Drag {
  pointerId: number;
  from: string;
  el: HTMLElement | null;
  rect: DOMRect;
  size: number;
  x0: number;
  y0: number;
  started: boolean;
  touch: boolean;
  /** un clic sur la pièce déjà sélectionnée la désélectionne au relâchement */
  deselectOnUp: boolean;
  raf: number;
  lastX: number;
  lastY: number;
}

/**
 * Plateau ChessArena — rendu maison, pensé pour 60 FPS :
 *  - le damier est UN seul élément (dégradé conique), pas 64 cases ;
 *  - chaque pièce est un élément stable déplacé uniquement par `transform` (composité par le GPU,
 *    `will-change`), animé par transition CSS ; aucune mise en page pendant les animations ;
 *  - le glisser-déposer écrit directement dans le style de la pièce (pointer events + rAF),
 *    sans aucun rendu React pendant le geste ;
 *  - souris, tactile et stylet (pointer events), clic-clic, clic droit = annuler les pré-moves ;
 *  - pré-moves illimités affichés sur la position virtuelle, promotion par dialogue.
 */
export const GameBoard = memo(function GameBoard(p: Props) {
  const boardRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const premoving = !p.myTurn || p.premoves.length > 0;

  // ─── Modèle : position virtuelle → sprites à identité stable ──────────────
  const board = useMemo(() => virtualBoard(p.fen, p.premoves), [p.fen, p.premoves]);
  const spritesRef = useRef<PieceSprite[]>([]);
  const idSeq = useRef(0);
  const sprites = useMemo(() => {
    const next = reconcileSprites(spritesRef.current, board, () => `p${++idSeq.current}`);
    spritesRef.current = next;
    return next;
  }, [board]);

  // pièces prises : fondu de sortie au lieu d'une disparition sèche
  const [fading, setFading] = useState<PieceSprite[]>([]);
  const rendered = useRef<PieceSprite[]>([]);
  useLayoutEffect(() => {
    const ids = new Set(sprites.map((s) => s.id));
    const gone = rendered.current.filter((s) => !ids.has(s.id));
    rendered.current = sprites;
    if (gone.length === 0) return;
    setFading((f) => [...f, ...gone]);
    const t = setTimeout(() => setFading((f) => f.filter((s) => !gone.includes(s))), 220);
    return () => clearTimeout(t);
  }, [sprites]);

  // la sélection n'a plus de sens si la pièce n'est plus là (coup adverse, rollback)
  useEffect(() => {
    if (selected && board.get(selected)?.[0] !== p.myColor) setSelected(null);
  }, [board, selected, p.myColor]);
  useEffect(() => { if (!p.interactive) { setSelected(null); setPromo(null); } }, [p.interactive]);

  // ─── Surbrillances ────────────────────────────────────────────────────────
  const targets = useMemo(() => {
    if (!selected) return [] as string[];
    return premoving ? premoveDests(board, selected) : legalTargets(p.serverFen, selected);
  }, [selected, premoving, board, p.serverFen]);
  const last = uciToSquares(p.lastMove);
  const check = useMemo(() => checkedKing(p.fen), [p.fen]);

  // ─── Coups ────────────────────────────────────────────────────────────────
  const attempt = useCallback((from: string, to: string): boolean => {
    if (!premoving && isPromotion(p.serverFen, from, to)) {
      setPromo({ from, to });
      return false;
    }
    return p.onMove(from, to);
  }, [premoving, p]);

  const pieceEl = (sq: string) =>
    boardRef.current?.querySelector<HTMLElement>(`.arena-piece[data-sq="${sq}"]:not(.arena-fading)`) ?? null;

  const locate = (rect: DOMRect, size: number, clientX: number, clientY: number) =>
    xyToSquare(Math.floor((clientX - rect.left) / size), Math.floor((clientY - rect.top) / size), p.orientation);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    sound.unlock();
    if (e.button === 2) return;
    if (!p.interactive || promo) return;
    const rect = boardRef.current!.getBoundingClientRect();
    const size = rect.width / 8;
    const sq = locate(rect, size, e.clientX, e.clientY);
    if (!sq) return;
    const piece = board.get(sq);
    const own = piece?.[0] === p.myColor;
    if (selected && sq !== selected && !own) {
      attempt(selected, sq);
      setSelected(null);
      return;
    }
    if (!own) { setSelected(null); return; }
    e.preventDefault();
    boardRef.current!.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId, from: sq, el: pieceEl(sq), rect, size, x0: e.clientX, y0: e.clientY,
      started: false, touch: e.pointerType === "touch", deselectOnUp: selected === sq, raf: 0, lastX: e.clientX, lastY: e.clientY,
    };
    if (selected !== sq) setSelected(sq);
  };

  const paint = () => {
    const d = drag.current;
    if (!d) return;
    d.raf = 0;
    const lift = d.touch ? d.size * 0.55 : 0;
    const px = d.lastX - d.rect.left - d.size / 2;
    const py = d.lastY - d.rect.top - d.size / 2 - lift;
    if (d.el) d.el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    const over = locate(d.rect, d.size, d.lastX, d.lastY - lift);
    const h = hoverRef.current;
    if (h) {
      if (over) { h.style.opacity = "1"; h.style.transform = sqTransform(over, p.orientation); }
      else h.style.opacity = "0";
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < (d.touch ? 6 : 3)) return;
      d.started = true;
      d.deselectOnUp = false;
      if (d.el) { d.el.style.transition = "none"; d.el.classList.add("dragging"); if (d.touch) d.el.classList.add("touch"); }
    }
    if (!d.raf) d.raf = requestAnimationFrame(paint);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (hoverRef.current) hoverRef.current.style.opacity = "0";
    const el = d.el;
    if (!d.started) {
      if (d.deselectOnUp) setSelected(null);
      return;
    }
    el?.classList.remove("dragging", "touch");
    const lift = d.touch ? d.size * 0.55 : 0;
    const to = cancelled ? null : locate(d.rect, d.size, e.clientX, e.clientY - lift);
    const restore = (sq: string) => {
      if (!el) return;
      el.style.transition = "";
      el.style.transform = sqTransform(sq, p.orientation);
    };
    if (!to || to === d.from) { restore(d.from); return; }
    // la pièce se pose instantanément sur la case visée ; si le coup est refusé, elle revient en glissant
    if (el) el.style.transform = sqTransform(to, p.orientation);
    const ok = attempt(d.from, to);
    setSelected(null);
    requestAnimationFrame(() => (ok ? el && (el.style.transition = "") : restore(d.from)));
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setSelected(null);
    setPromo(null);
    p.onCancelPremoves();
  };

  // Échap : annule sélection et pré-moves (clavier)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSelected(null); setPromo(null); p.onCancelPremoves(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const themeVars = BOARD_THEMES[p.theme].vars as CSSProperties;
  const at = (sq: string): CSSProperties => ({ transform: sqTransform(sq, p.orientation) });
  const premoveSquares = new Set(p.premoves.flatMap((m) => [m.from, m.to]));

  return (
    <div
      ref={boardRef}
      className="arena-board"
      data-theme={p.theme}
      style={themeVars}
      role="application"
      aria-label={`Échiquier, vous avez les ${p.myColor === "w" ? "blancs" : "noirs"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onContextMenu={onContextMenu}
    >
      <PieceDefs />
      <div className="arena-board-overlay" aria-hidden />

      {/* surbrillances : un élément par case marquée, positionné par transform */}
      {last && [last[0], last[1]].map((sq) => <div key={`l${sq}`} className="arena-hl hl-last" style={at(sq)} />)}
      {[...premoveSquares].map((sq) => <div key={`pm${sq}`} className="arena-hl hl-premove" style={at(sq)} />)}
      {selected && <div className="arena-hl hl-selected" style={at(selected)} />}
      {check && <div className="arena-hl hl-check" style={at(check)} />}
      {targets.map((sq) => (
        <div key={`t${sq}`} className={`arena-hl hl-target${board.has(sq) ? " occupied" : ""}${premoving ? " pre" : ""}`} style={at(sq)} />
      ))}
      <div ref={hoverRef} className="arena-hl hl-hover" style={{ opacity: 0 }} />

      {p.coordinates && <Coordinates orientation={p.orientation} />}

      {fading.map((s) => (
        <div key={`f${s.id}`} className="arena-piece arena-fading" data-sq={s.square} style={at(s.square)}>
          <PieceSvg code={s.code} />
        </div>
      ))}
      {sprites.map((s) => (
        <div
          key={s.id}
          className={`arena-piece${s.code[0] === p.myColor && p.interactive ? " mine" : ""}`}
          data-sq={s.square}
          style={at(s.square)}
          aria-label={`${PIECE_NAMES[s.code[1] as keyof typeof PIECE_NAMES]} ${s.code[0] === "w" ? "blanc" : "noir"} en ${s.square}`}
        >
          <PieceSvg code={s.code} />
        </div>
      ))}

      {p.arrows && p.arrows.length > 0 && <Arrows arrows={p.arrows} orientation={p.orientation} />}

      {promo && (
        <PromotionPicker
          color={p.myColor}
          square={promo.to}
          orientation={p.orientation}
          onPick={(piece) => {
            const pending = promo;
            setPromo(null);
            if (piece) p.onMove(pending.from, pending.to, piece);
          }}
        />
      )}
    </div>
  );
});

/** Flèches en SVG (unité = une case), au-dessus des pièces, ignorées par la souris. */
function Arrows({ arrows, orientation }: { arrows: NonNullable<Props["arrows"]>; orientation: Color }) {
  const c = (sq: string) => {
    const f = FILES.indexOf(sq[0]!); const r = Number(sq[1]) - 1;
    return orientation === "w" ? [f + 0.5, 7 - r + 0.5] : [7 - f + 0.5, r + 0.5];
  };
  return (
    <svg className="pointer-events-none absolute inset-0 z-40 size-full" viewBox="0 0 8 8" aria-hidden>
      {arrows.map(({ from, to, color = "#22d3ee" }, i) => {
        const [x1, y1] = c(from); const [x2, y2] = c(to);
        const dx = x2! - x1!; const dy = y2! - y1!; const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len; const uy = dy / len; const head = 0.42; const w = 0.14;
        const bx = x2! - ux * head; const by = y2! - uy * head; // base de la pointe
        const nx = -uy; const ny = ux;
        const pts = [
          [x1! + nx * w / 2, y1! + ny * w / 2], [bx + nx * w / 2, by + ny * w / 2], [bx + nx * head * 0.55, by + ny * head * 0.55],
          [x2!, y2!], [bx - nx * head * 0.55, by - ny * head * 0.55], [bx - nx * w / 2, by - ny * w / 2], [x1! - nx * w / 2, y1! - ny * w / 2],
        ].map(([x, y]) => `${x!.toFixed(3)},${y!.toFixed(3)}`).join(" ");
        return <polygon key={i} points={pts} fill={color} opacity={0.78} />;
      })}
    </svg>
  );
}

const Coordinates = memo(function Coordinates({ orientation }: { orientation: Color }) {
  const files = orientation === "w" ? FILES.split("") : FILES.split("").reverse();
  const ranks = orientation === "w" ? ["8", "7", "6", "5", "4", "3", "2", "1"] : ["1", "2", "3", "4", "5", "6", "7", "8"];
  // case claire en bas à droite (h1 / a8) : la couleur du label alterne avec la case
  return (
    <div className="arena-coords" aria-hidden>
      {files.map((f, i) => (
        <span key={f} className={`coord file ${i % 2 === 0 ? "on-dark" : "on-light"}`} style={{ left: `${i * 12.5}%` }}>{f}</span>
      ))}
      {ranks.map((r, i) => (
        <span key={r} className={`coord rank ${i % 2 === 0 ? "on-light" : "on-dark"}`} style={{ top: `${i * 12.5}%` }}>{r}</span>
      ))}
    </div>
  );
});

function PromotionPicker({ color, square, orientation, onPick }: {
  color: Color; square: string; orientation: Color; onPick: (p: PromotionPiece | null) => void;
}) {
  const { x, y } = squareToXY(square, orientation);
  const fromTop = y === 0;
  const pieces: PromotionPiece[] = ["q", "n", "r", "b"];
  return (
    <div className="arena-promo-scrim" onPointerDown={(e) => { e.stopPropagation(); onPick(null); }}>
      <div
        className="arena-promo"
        role="dialog"
        aria-label="Choix de la promotion"
        style={{ left: `${x * 12.5}%`, ...(fromTop ? { top: 0 } : { bottom: 0 }), flexDirection: fromTop ? "column" : "column-reverse" }}
      >
        {pieces.map((pc) => (
          <button
            key={pc}
            type="button"
            className="arena-promo-btn"
            aria-label={PIECE_NAMES[pc]}
            onPointerDown={(e) => { e.stopPropagation(); onPick(pc); }}
          >
            <PieceSvg code={`${color}${pc}` as PieceCode} />
          </button>
        ))}
      </div>
    </div>
  );
}
