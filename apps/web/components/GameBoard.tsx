"use client";
import { useMemo, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Piece, PromotionPieceOption, Square } from "react-chessboard/dist/chessboard/types";
import type { Color } from "@chessarena/shared";
import { isPromotion, legalTargets, pieceColorAt, uciToSquares, type Premove, type PromotionPiece } from "../lib/moves";

interface Props {
  fen: string;
  /** position serveur (pour calculer les cibles légales du joueur au trait) */
  serverFen: string;
  myColor: Color;
  interactive: boolean;
  myTurn: boolean;
  lastMove: string | null;
  premove: Premove | null;
  onMove: (from: string, to: string, promotion?: PromotionPiece) => boolean;
  onCancelPremove: () => void;
}

const LAST_MOVE: CSSProperties = { background: "rgba(255, 213, 0, 0.35)" };
const PREMOVE: CSSProperties = { background: "rgba(20, 85, 200, 0.4)" };
const SELECTED: CSSProperties = { background: "rgba(20, 160, 90, 0.45)" };
const TARGET: CSSProperties = { background: "radial-gradient(circle, rgba(0,0,0,.22) 22%, transparent 24%)" };

/**
 * Plateau : glisser-déposer ET clic-clic, pré-moves (clic droit pour annuler),
 * dialogue de sous-promotion, surbrillance du dernier coup et des cibles légales.
 */
export function GameBoard(p: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);

  const targets = useMemo(
    () => (selected && p.myTurn ? legalTargets(p.serverFen, selected) : []),
    [selected, p.myTurn, p.serverFen],
  );

  const styles = useMemo(() => {
    const s: Record<string, CSSProperties> = {};
    const lm = uciToSquares(p.lastMove);
    if (lm) { s[lm[0]] = LAST_MOVE; s[lm[1]] = LAST_MOVE; }
    if (p.premove) { s[p.premove.from] = PREMOVE; s[p.premove.to] = PREMOVE; }
    if (selected) s[selected] = SELECTED;
    for (const t of targets) s[t] = { ...s[t], ...TARGET };
    return s;
  }, [p.lastMove, p.premove, selected, targets]);

  const attempt = (from: string, to: string): boolean => {
    setSelected(null);
    // promotion pendant MON tour → dialogue ; en pré-move → dame par défaut
    if (p.myTurn && isPromotion(p.serverFen, from, to)) {
      setPromo({ from, to });
      return false;
    }
    return p.onMove(from, to);
  };

  const onSquareClick = (square: Square) => {
    if (!p.interactive) return;
    if (selected && selected !== square) {
      if (pieceColorAt(p.fen, square) === p.myColor) return setSelected(square); // change de pièce
      attempt(selected, square);
      return;
    }
    setSelected(pieceColorAt(p.fen, square) === p.myColor && selected !== square ? square : null);
  };

  return (
    <div onContextMenu={(e) => e.preventDefault()} className="select-none">
      <Chessboard
        id="arena-board"
        position={p.fen}
        boardOrientation={p.myColor === "w" ? "white" : "black"}
        animationDuration={120}
        arePiecesDraggable={p.interactive}
        isDraggablePiece={({ piece }: { piece: Piece }) => p.interactive && piece[0] === p.myColor}
        onPieceDragBegin={(_piece: Piece, sq: Square) => setSelected(sq)}
        onPieceDrop={(from: Square, to: Square) => attempt(from, to)}
        onPromotionCheck={() => false /* promotions gérées par notre propre dialogue (clic ET glisser) */}
        onSquareClick={onSquareClick}
        onSquareRightClick={() => { setSelected(null); p.onCancelPremove(); }}
        showPromotionDialog={promo !== null}
        promotionToSquare={(promo?.to as Square | undefined) ?? null}
        onPromotionPieceSelect={(piece?: PromotionPieceOption) => {
          const pending = promo;
          setPromo(null);
          if (!piece || !pending) return false;
          return p.onMove(pending.from, pending.to, piece[1]!.toLowerCase() as PromotionPiece);
        }}
        customSquareStyles={styles}
        customBoardStyle={{ borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,.25)" }}
      />
    </div>
  );
}
