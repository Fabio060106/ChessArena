"use client";
import { useEffect, useRef, useState } from "react";
import type { BetView, OddsView, PredictionPick, PredictionsMine, RelayGameView } from "@chessarena/shared";
import { BET_ERRORS } from "../hooks/usePredictions";
import { formatMoney } from "../lib/tournament";

const STAKES = [100, 500, 1_000, 2_500];
const LABEL: Record<PredictionPick, string> = { white: "1", draw: "N", black: "2" };
const fmt = (c: number) => formatMoney(c, "PLAY");

/**
 * Pronostic en direct sur la partie affichée : cotes 1 / N / 2 calculées par Stockfish après chaque coup
 * (flèches quand la cote bouge), mise en jetons à cote figée, gain potentiel, mes paris, meilleurs pronostiqueurs.
 */
export function PredictionPanel({ game, round, odds, mine, onPlace }: {
  game: RelayGameView; round: number; odds: OddsView | null; mine: PredictionsMine | null;
  onPlace: (pick: PredictionPick, stakeCents: number, version: number) => Promise<{ ok: boolean; code?: string }>;
}) {
  const [pick, setPick] = useState<PredictionPick | null>(null);
  const [stake, setStake] = useState(500);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const prev = useRef<OddsView["odds"]>(null);
  const [trend, setTrend] = useState<Partial<Record<PredictionPick, "up" | "down">>>({});
  useEffect(() => {
    if (!odds?.odds) return;
    const p = prev.current;
    if (p) setTrend({ white: cmp(p.white, odds.odds.white), draw: cmp(p.draw, odds.odds.draw), black: cmp(p.black, odds.odds.black) });
    prev.current = odds.odds;
  }, [odds?.odds]);

  const names: Record<PredictionPick, string> = { white: game.white.name, draw: "Nulle", black: game.black.name };
  const open = !!odds && !odds.closed && !odds.suspended && !!odds.odds;
  const myBets = (mine?.bets ?? []).filter((b) => b.market.endsWith(`:${round}:${game.index}`) && b.relayId === odds?.relayId);
  const potential = pick && odds?.odds ? Math.floor(stake * odds.odds[pick]) : null;

  const submit = async () => {
    if (!pick || !odds) return;
    setBusy(true); setMsg(null);
    const r = await onPlace(pick, stake, odds.version);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `Pronostic enregistré : ${names[pick]} à ${odds.odds![pick].toFixed(2)}.` } : { ok: false, text: BET_ERRORS[r.code ?? ""] ?? "Pronostic impossible pour l'instant." });
    if (r.ok) setPick(null);
  };

  return (
    <section className="panel flex flex-col gap-2 border-gold/30 p-3" aria-label="Pronostics">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[.14em] text-gold">Pronostic en direct</h2>
        {mine && <span className="tabular text-xs text-muted">Solde : <b className="text-text">{fmt(mine.balanceCents)}</b></span>}
      </div>
      {!odds || (!odds.odds && !odds.closed) ? (
        <p className="text-sm text-muted">{odds?.suspended ? "Cotes indisponibles pour le moment." : "Calcul des cotes par Stockfish…"}</p>
      ) : odds.closed ? (
        <p className="text-sm">Partie terminée ({odds.result}) : les pronostics sont réglés.</p>
      ) : (
        <>
          {odds.probs && (
            <div className="flex h-2 overflow-hidden rounded-full" aria-label="Probabilités">
              <span className="bg-[#e8e8e8]" style={{ width: `${odds.probs.white * 100}%` }} />
              <span className="bg-muted/60" style={{ width: `${odds.probs.draw * 100}%` }} />
              <span className="bg-[#333]" style={{ width: `${odds.probs.black * 100}%` }} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Issue">
            {(["white", "draw", "black"] as const).map((p) => (
              <button key={p} type="button" disabled={!open} aria-pressed={pick === p} onClick={() => setPick(p)}
                className={`flex flex-col items-center rounded-lg border px-1 py-2 disabled:opacity-50 ${pick === p ? "border-gold bg-gold/10" : "border-line hover:border-gold/50"}`}>
                <span className="block w-full truncate px-0.5 text-center text-[11px] text-muted">{LABEL[p]} · {names[p]}</span>
                <span className="tabular font-display text-lg font-bold">
                  {odds.odds![p].toFixed(2)}
                  {trend[p] === "up" && <span className="ml-0.5 text-xs text-win">▲</span>}
                  {trend[p] === "down" && <span className="ml-0.5 text-xs text-danger">▼</span>}
                </span>
              </button>
            ))}
          </div>
          {odds.suspended && <p className="text-xs text-muted">Marché suspendu : l'issue est quasi certaine.</p>}
          {pick && (
            <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-2">
              <div className="flex gap-1.5" role="group" aria-label="Mise">
                {STAKES.map((s) => (
                  <button key={s} type="button" aria-pressed={stake === s} onClick={() => setStake(s)}
                    className={`flex-1 rounded-md border px-1 py-1 text-xs font-semibold ${stake === s ? "border-gold text-gold" : "border-line text-muted"}`}>{s / 100}</button>
                ))}
              </div>
              <button type="button" disabled={busy || !open} onClick={() => void submit()} className="rounded-lg bg-gold px-3 py-2 text-sm font-semibold text-ink disabled:opacity-60">
                {busy ? "…" : `Miser ${fmt(stake)} sur ${names[pick]} · gain ${fmt(potential ?? 0)}`}
              </button>
            </div>
          )}
        </>
      )}
      {msg && <p role="status" className={`text-xs ${msg.ok ? "text-win" : "text-danger"}`}>{msg.text}</p>}
      {myBets.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line pt-2 text-xs">
          {myBets.slice(0, 6).map((b) => <BetRow key={b.id} b={b} names={names} />)}
        </ul>
      )}
      {mine && mine.leaders.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Meilleurs pronostiqueurs du mois</summary>
          <ol className="mt-1 flex flex-col gap-0.5">
            {mine.leaders.slice(0, 5).map((l, i) => (
              <li key={l.userId} className="flex gap-2"><span className="w-4 text-muted">{i + 1}</span><span className="flex-1 truncate">{l.userId}</span>
                <span className={`tabular font-semibold ${l.netCents >= 0 ? "text-win" : "text-danger"}`}>{l.netCents >= 0 ? "+" : ""}{fmt(l.netCents)}</span></li>
            ))}
          </ol>
        </details>
      )}
      <p className="text-[10px] text-muted/80">Jetons sans valeur, pour le jeu. Cotes calculées par Stockfish après chaque coup (marge de 6 %), figées au moment de la mise.</p>
    </section>
  );
}

function BetRow({ b, names }: { b: BetView; names: Record<PredictionPick, string> }) {
  const tone = b.status === "won" ? "text-win" : b.status === "lost" ? "text-danger" : "text-muted";
  return (
    <li className="flex items-center gap-2">
      <span className="flex-1 truncate">{names[b.pick]} à {b.odds.toFixed(2)} · {fmt(b.stakeCents)}</span>
      <span className={`tabular font-semibold ${tone}`}>
        {b.status === "open" ? `→ ${fmt(Math.floor(b.stakeCents * b.odds))}` : b.status === "won" ? `+${fmt(b.payoutCents - b.stakeCents)}` : b.status === "lost" ? `−${fmt(b.stakeCents)}` : "remboursé"}
      </span>
    </li>
  );
}

const cmp = (a: number, b: number): "up" | "down" | undefined => (b > a ? "up" : b < a ? "down" : undefined);
