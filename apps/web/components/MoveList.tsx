"use client";
import { memo, useEffect, useRef } from "react";

interface Props {
  moves: ReadonlyArray<string | null>;
  /** demi-coup surligné (0-based) ; par défaut le dernier */
  active?: number;
  /** relecture : clic sur un coup → aller à la position après ce coup */
  onSelect?: (ply: number) => void;
  /** annotations par demi-coup (analyse) : « ?! », « ? », « ?? » */
  marks?: ReadonlyArray<"??" | "?" | "?!" | null | undefined>;
}

const MARK_CLS = { "??": "text-danger", "?": "text-[#fb923c]", "?!": "text-gold" } as const;

/** Liste des coups (SAN) en paires ; suit le coup actif sans faire défiler la page. */
export const MoveList = memo(function MoveList({ moves, active = moves.length - 1, onSelect, marks }: Props) {
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-ply="${active}"]`);
    const b = box.current;
    if (!el || !b) return;
    const top = el.offsetTop - b.offsetTop;
    if (top < b.scrollTop || top > b.scrollTop + b.clientHeight - el.offsetHeight) b.scrollTop = top - b.clientHeight / 2;
  }, [active, moves.length]);
  const rows: Array<[string | null, string | null | undefined]> = [];
  for (let i = 0; i < moves.length; i += 2) rows.push([moves[i] ?? null, moves[i + 1]]);
  if (rows.length === 0) return <p className="px-1 text-sm text-muted">Aucun coup joué.</p>;
  const cell = (m: string | null | undefined, ply: number) => {
    if (m === undefined) return <span />;
    const mk = marks?.[ply];
    const label = <>{m ?? "…"}{mk && <span className={`ml-0.5 font-bold ${MARK_CLS[mk]}`}>{mk}</span>}</>;
    const cls = `rounded px-1.5 py-1 text-left font-medium ${ply === active ? "bg-neon/15 text-neon" : ""} ${onSelect ? "hover:bg-surface-2" : ""}`;
    return onSelect
      ? <button type="button" data-ply={ply} className={cls} onClick={() => onSelect(ply)}>{label}</button>
      : <span data-ply={ply} className={cls}>{label}</span>;
  };
  return (
    <ol ref={box} className="relative grid max-h-64 grid-cols-[2.25rem_1fr_1fr] content-start gap-y-0.5 overflow-y-auto text-sm lg:max-h-[40vh]">
      {rows.map(([w, b], i) => (
        <li key={i} className="contents">
          <span className="tabular py-1 pl-1 text-muted">{i + 1}.</span>
          {cell(w, i * 2)}
          {cell(b, i * 2 + 1)}
        </li>
      ))}
    </ol>
  );
});
