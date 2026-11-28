"use client";
import { useMemo, useRef, useState } from "react";
import type { PlayerProfile, TimeControlId } from "@chessarena/shared";
import { chartGeometry, chartSummary, nearestIndex } from "../lib/ratingChart";
import { TC_LABEL, TC_ORDER } from "../lib/social";

const W = 600, H = 160;

/** Évolution de l'Elo, une cadence à la fois ; survol ou toucher pour lire un point. */
export function RatingChart({ history, initial }: { history: NonNullable<PlayerProfile["ratingHistory"]>; initial?: TimeControlId }) {
  const tcs = TC_ORDER.filter((tc) => (history[tc]?.length ?? 0) >= 2);
  const [tc, setTc] = useState<TimeControlId | undefined>(initial && tcs.includes(initial) ? initial : tcs[0]);
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const points = tc ? history[tc] ?? [] : [];
  const g = useMemo(() => chartGeometry(points, W, H), [points]);
  const sum = chartSummary(points);
  if (!tcs.length || !tc || !g || !sum) return null;

  const pick = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (r) setHover(nearestIndex(points.length, ((clientX - r.left) / r.width) * W, W));
  };
  const h = hover !== null ? g.xy[hover] : null;
  const date = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

  return (
    <section className="panel p-4" aria-label="Évolution de l'Elo">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Évolution de l'Elo</h2>
        {tcs.length > 1 && (
          <div className="ml-auto flex gap-1 rounded-lg bg-surface-2 p-0.5" role="tablist">
            {tcs.map((x) => (
              <button key={x} type="button" role="tab" aria-selected={x === tc} onClick={() => { setTc(x); setHover(null); }}
                className={`rounded-md px-2 py-1 text-xs font-semibold ${x === tc ? "bg-ink text-text ring-1 ring-neon/40" : "text-muted hover:text-text"}`}>
                {TC_LABEL[x]}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="tabular mb-2 text-xs text-muted">
        {h ? <>{hover ? `Partie ${hover}` : "Départ"} · {date(h.p.at)} · <span className="font-semibold text-text">{h.p.rating}</span></>
          : <>{points.length - 1} partie{points.length > 2 ? "s" : ""} · <span className={sum.delta >= 0 ? "text-win" : "text-danger"}>{sum.delta >= 0 ? "+" : ""}{sum.delta}</span> · record {sum.best}</>}
      </p>
      <div className="relative">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full touch-none text-neon"
          onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setHover(null)}
          role="img" aria-label={`Elo ${TC_LABEL[tc]} : de ${sum.first} à ${sum.last} en ${points.length - 1} parties`}>
          {g.ticks.map((t) => {
            const y = 8 + (1 - (t - g.min) / (g.max - g.min)) * (H - 16);
            return <line key={t} x1={0} x2={W} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.08} vectorEffect="non-scaling-stroke" />;
          })}
          <path d={g.area} fill="currentColor" fillOpacity={0.08} />
          <path d={g.line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {h && <line x1={h.x} x2={h.x} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* le point survolé, en HTML pour rester rond malgré l'étirement du SVG */}
        {h && <span className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-neon"
          style={{ left: `${(h.x / W) * 100}%`, top: `${(h.y / H) * 100}%` }} />}
        <div className="tabular pointer-events-none absolute inset-y-0 right-1 flex flex-col justify-between py-1 text-[10px] text-muted">
          <span>{g.max}</span><span>{g.min}</span>
        </div>
      </div>
    </section>
  );
}
