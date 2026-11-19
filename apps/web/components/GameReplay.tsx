"use client";
import { useEffect, useMemo, useState } from "react";
import type { GameHistoryDetail, TimeControlId } from "@chessarena/shared";
import { PlayerCard } from "./PlayerCard";
import { AnalysisBoard, type AnalysisCtx } from "./AnalysisBoard";
import { material } from "../lib/material";
import { materialAdvantage } from "../lib/profile";
import { formatThink, replayFromPgn } from "../lib/replay";
import { fetchWake, localCache } from "../lib/wake";
import { addMove, addUcis, newTree, ucisTo } from "../lib/tree";

export const TC: Record<TimeControlId, string> = { bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0" };
export const TERM: Record<string, string> = {
  checkmate: "échec et mat", resignation: "abandon", timeout: "temps écoulé", abandon: "forfait", stalemate: "pat",
  repetition: "répétition", insufficient_material: "matériel insuffisant", fifty_moves: "50 coups", aborted: "annulée",
  agreement: "accord mutuel", timeout_vs_insufficient_material: "temps, matériel insuffisant",
};
export const OUTCOME = {
  win: { label: "Victoire", cls: "bg-win/15 text-win" },
  loss: { label: "Défaite", cls: "bg-danger/15 text-danger" },
  draw: { label: "Nulle", cls: "bg-surface-2 text-text" },
  aborted: { label: "Annulée", cls: "bg-surface-2 text-muted" },
} as const;

/**
 * Relecture + analyse d'une partie : tableau d'analyse complet (variantes sans limite, plusieurs suites du moteur,
 * annotation de chaque coup) à partir des coups de la partie. `publicView` : partie d'un autre joueur (lien partagé),
 * vue du côté des Blancs (ou du joueur s'il y a participé). `initial` : position (ply) et variante (UCI) d'un lien partagé.
 */
export function GameReplay({ gameId, me: viewer, publicView = false, initial }: {
  gameId: string; me: string; publicView?: boolean; initial?: { ply?: number; variation?: string[] };
}) {
  const [g, setG] = useState<GameHistoryDetail | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const key = `${publicView ? "pgame" : "game"}.${gameId}`;
    const cached = localCache.get<GameHistoryDetail>(key);
    if (cached) setG(cached);
    fetchWake(publicView ? `/api/games/${gameId}` : `/api/history/${gameId}`)
      .then(async (r) => {
        if (!r?.ok) { if (cached) return; throw new Error(String(r?.status ?? "")); }
        const d = (await r.json()) as GameHistoryDetail;
        localCache.set(key, d);
        if (!cached) setG(d); // une partie terminée ne change plus
      })
      .catch(() => setErr(true));
  }, [gameId, publicView]);

  const setup = useMemo(() => {
    if (!g) return null;
    const steps = replayFromPgn(g.pgn);
    let tree = newTree(steps[0]!.fen);
    const ids = [tree.root];
    for (const s of steps.slice(1)) { const r = addMove(tree, ids.at(-1)!, { fen: s.fen, san: s.san!, uci: s.uci! }); tree = r.tree; ids.push(r.id); }
    let at: string | undefined;
    if (initial?.ply !== undefined || initial?.variation?.length) {
      const base = ids[Math.max(0, Math.min(ids.length - 1, initial?.ply ?? ids.length - 1))]!;
      const r = addUcis(tree, base, initial?.variation ?? []);
      tree = r.tree; at = r.id;
    } else at = undefined;
    return { tree, ucis: steps.slice(1).map((s) => s.uci!), last: ids.at(-1)!, at };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g]);

  if (err) return <p className="panel p-4 text-sm text-danger">Impossible de charger cette partie (lien erroné, ou partie pas encore terminée).</p>;
  if (!g || !setup) return <p className="panel p-4 text-sm text-muted">Chargement de la partie…</p>;

  const opp = g.color === "w" ? "b" : "w";
  // point de vue : le joueur connecté s'il a joué la partie, sinon les Blancs (partie partagée)
  const me = g.player ?? viewer;
  const neutral = publicView && me !== viewer;
  const names = g.color === "w" ? { w: me, b: g.opponent } : { w: g.opponent, b: me };
  const think = (c: "w" | "b", ply: number | null) => (ply && ply > 0 && ply % 2 === (c === "w" ? 1 : 0) ? formatThink(g.moveTimesMs[ply - 1]) : "");
  const card = (c: "w" | "b", x: AnalysisCtx) => {
    const mat = material(x.fen);
    return c === g.color ? (
      <PlayerCard userId={me} isMe={!neutral} rating={g.ratingBefore ?? undefined}
        materialAdvantage={materialAdvantage(x.fen, c)} captured={mat[c].captured}
        clock={<span className="tabular text-xs text-muted">{think(c, x.gamePly)}</span>} />
    ) : (
      <PlayerCard userId={g.opponent} rating={g.opponentRating ?? undefined}
        materialAdvantage={materialAdvantage(x.fen, c)} captured={mat[c].captured}
        clock={<span className="tabular text-xs text-muted">{think(c, x.gamePly)}</span>} />
    );
  };
  // en haut : le camp opposé à celui affiché en bas
  const bottomOf = (x: AnalysisCtx) => (x.flipped ? opp : g.color);

  return (
    <AnalysisBoard
      key={gameId}
      initialTree={setup.tree}
      initialNode={setup.at}
      defaultNode={setup.last}
      resetKey={gameId}
      gameUcis={setup.ucis}
      orientation={g.color}
      storageKey={publicView ? undefined : `arena.analysis.game.${gameId}`}
      engineOnOpen={false}
      names={names}
      cardTop={(x) => card(bottomOf(x) === "w" ? "b" : "w", x)}
      cardBottom={(x) => card(bottomOf(x), x)}
      footer={(x) => (
        <div className="panel p-3">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">
              {neutral ? (g.result === "1-0" ? "Victoire des Blancs" : g.result === "0-1" ? "Victoire des Noirs" : OUTCOME[g.outcome].label) : OUTCOME[g.outcome].label} · {g.result}{" "}
              <span className="font-normal text-muted">({TERM[g.termination] ?? g.termination})</span>
            </p>
            <p className="text-xs text-muted">{TC[g.timeControl]} · {new Date(g.endedAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}</p>
          </div>
          <ShareButton gameId={gameId} ctx={x} gameUcis={setup.ucis} />
        </div>
      )}
    />
  );
}

/** Partager l'analyse : lien vers la partie, à la position affichée (et avec la variante en cours). */
function ShareButton({ gameId, ctx, gameUcis }: { gameId: string; ctx: AnalysisCtx; gameUcis: readonly string[] }) {
  const [done, setDone] = useState<string | null>(null);
  const path = ucisTo(ctx.tree, ctx.nodeId);
  let k = 0;
  while (k < path.length && path[k] === gameUcis[k]) k++;
  const variation = path.slice(k);
  const share = async () => {
    const q = new URLSearchParams();
    if (variation.length || k !== gameUcis.length) q.set("ply", String(k));
    if (variation.length) q.set("v", variation.join(","));
    const url = `${window.location.origin}/partie/${gameId}${q.size ? `?${q}` : ""}`;
    try {
      if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) { await navigator.share({ title: "Analyse de partie", url }); setDone("Partagé ✓"); }
      else { await navigator.clipboard.writeText(url); setDone("Lien copié ✓"); }
    } catch { setDone(url); }
    setTimeout(() => setDone(null), 4000);
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void share()} className="rounded-lg border border-neon/50 px-3 py-1.5 text-sm font-semibold text-neon hover:bg-neon/10">
        🔗 Partager cette position
      </button>
      {done && <span role="status" className="break-all text-xs text-muted">{done}</span>}
      <span className="text-[11px] text-muted">Le lien ouvre la partie à cette position{variation.length ? ", avec ta variante" : ""}.</span>
    </div>
  );
}
