"use client";
import { useEffect, useRef } from "react";

/** Liste des coups (notation algébrique), par paires, défilement automatique sur le dernier coup. */
export function MoveList({ moves }: { moves: ReadonlyArray<string | null> }) {
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [moves.length]);
  if (moves.length === 0) return <p className="text-sm text-neutral-500">Aucun coup joué.</p>;
  const rows: Array<[string | null, string | null | undefined]> = [];
  for (let i = 0; i < moves.length; i += 2) rows.push([moves[i] ?? null, moves[i + 1]]);
  const last = moves.length - 1;
  const cell = (m: string | null | undefined, idx: number) => (
    <span className={`rounded px-1.5 py-0.5 font-medium ${idx === last ? "bg-neutral-200 dark:bg-neutral-700" : ""}`}>
      {m === undefined ? "" : m ?? "…"}
    </span>
  );
  return (
    <ol ref={box} className="grid max-h-56 grid-cols-[2.5rem_1fr_1fr] items-center gap-y-0.5 overflow-y-auto text-sm lg:max-h-[45vh]">
      {rows.map(([w, b], i) => (
        <li key={i} className="contents">
          <span className="tabular-nums text-neutral-500">{i + 1}.</span>
          {cell(w, i * 2)}
          {cell(b, i * 2 + 1)}
        </li>
      ))}
    </ol>
  );
}
