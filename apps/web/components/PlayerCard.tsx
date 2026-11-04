"use client";
import { memo, type ReactNode } from "react";
import { avatarFor, countryName, flagEmoji, pingQuality, type PingQuality } from "../lib/profile";

interface Props {
  userId: string;
  rating?: number;
  flag?: string;
  /** RTT mesuré par le serveur (ms) */
  /** undefined = ne pas afficher (relecture d'une partie) */
  pingMs?: number | null;
  isMe?: boolean;
  /** au trait */
  toMove?: boolean;
  materialAdvantage?: number;
  /** pièces adverses prises par ce joueur (♛♜♝♞♟) */
  captured?: string;
  /** adversaire déconnecté : ms avant forfait */
  graceMs?: number | null;
  clock: ReactNode;
}

const PING_COLOR: Record<PingQuality, string> = {
  good: "text-win", fair: "text-gold", poor: "text-danger", unknown: "text-muted",
};

/**
 * Carte joueur du HUD : avatar, drapeau, Elo, ping réseau, badge fair-play discret, pendule.
 * Une seule ligne, hauteur fixe : rien ne bouge autour du plateau pendant la partie.
 */
export const PlayerCard = memo(function PlayerCard(p: Props) {
  const av = avatarFor(p.userId);
  const emoji = flagEmoji(p.flag);
  const country = countryName(p.flag);
  const q = pingQuality(p.pingMs);
  return (
    <div className={`flex h-14 items-center gap-3 rounded-xl px-2 sm:h-16 sm:px-3 ${p.toMove ? "bg-surface-2" : ""}`}>
      <div
        className="relative grid size-10 shrink-0 place-items-center rounded-lg text-sm font-bold text-white sm:size-11"
        style={{ background: `linear-gradient(135deg, hsl(${av.hue} 70% 46%), hsl(${(av.hue + 40) % 360} 75% 30%))` }}
        aria-hidden
      >
        {av.initials}
        {p.toMove && <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-neon shadow-[0_0_8px_#00E5FF]" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {emoji && <span title={country ?? undefined} aria-label={country ?? undefined} className="text-base leading-none">{emoji}</span>}
          <span className="truncate font-semibold text-text">{p.userId}</span>
          {p.isMe && <span className="text-xs text-muted">(vous)</span>}
          {p.rating !== undefined && <span className="tabular text-sm text-muted">{p.rating}</span>}
          {p.captured ? <span className="truncate text-sm leading-none tracking-tight text-muted" aria-label="Pièces prises">{p.captured}</span> : null}
          {p.materialAdvantage ? <span className="tabular text-xs font-semibold text-text">+{p.materialAdvantage}</span> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-[11px] leading-none">
          {p.pingMs !== undefined && (
            <span className={`flex items-center gap-1 ${PING_COLOR[q]}`} title="Ping mesuré par le serveur de jeu">
              <PingBars quality={q} />
              <span className="tabular">{p.pingMs === null ? "— ms" : `${p.pingMs} ms`}</span>
            </span>
          )}
          {p.graceMs != null ? (
            <span className="text-gold">déconnecté · forfait dans {Math.ceil(p.graceMs / 1000)} s</span>
          ) : (
            <span
              className="hidden items-center gap-1 text-muted/80 min-[380px]:flex"
              title="Fair-Play Monitored by Stockfish 19 — chaque partie est analysée après coup par Stockfish 19 (précision des coups, régularité des temps)."
            >
              <ShieldIcon />
              <span>Fair-Play · Stockfish 19</span>
            </span>
          )}
        </div>
      </div>

      <div className="shrink-0">{p.clock}</div>
    </div>
  );
});

function PingBars({ quality }: { quality: PingQuality }) {
  const n = quality === "good" ? 3 : quality === "fair" ? 2 : quality === "poor" ? 1 : 0;
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={i * 4} y={6 - i * 3} width="3" height={4 + i * 3} rx="0.8" fill="currentColor" opacity={i < n ? 1 : 0.25} />
      ))}
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="11" height="12" viewBox="0 0 12 14" aria-hidden>
      <path d="M6 1l4.5 1.8v3.6c0 3-1.9 5.4-4.5 6.6C3.4 11.8 1.5 9.4 1.5 6.4V2.8z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 7l1.5 1.5L8.2 5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
