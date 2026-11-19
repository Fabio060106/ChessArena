"use client";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "../../components/PageHeader";
import { AnalysisBoard, type AnalysisCtx } from "../../components/AnalysisBoard";
import { addUcis, newTree, parsePgn, PgnError, START_FEN, ucisTo, validFen, type Tree } from "../../lib/tree";

export default function AnalysePage() {
  return <Suspense><Analyse /></Suspense>;
}

/**
 * Tableau d'analyse libre, sans avoir joué de partie : position de départ, FEN ou PGN importé (variantes comprises),
 * on joue les deux camps et Stockfish analyse tout. Fonctionne sans compte et sans serveur (moteur dans le navigateur).
 */
function Analyse() {
  const q = useSearchParams();
  // lien partagé : ?fen=…&m=e2e4,e7e5
  const fromLink = useMemo(() => {
    const fen = q.get("fen");
    const m = (q.get("m") ?? "").split(",").filter((u) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)).slice(0, 400);
    if (!fen && !m.length) return null;
    const t = newTree(fen && validFen(fen) ? fen.trim() : START_FEN);
    return addUcis(t, t.root, m);
  }, [q]);

  const [state, setState] = useState<{ tree: Tree; node?: string; key: number }>(() =>
    fromLink ? { tree: fromLink.tree, node: fromLink.id, key: 1 } : { tree: newTree(), key: 0 });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    const t = text.trim();
    if (!t) return;
    setErr(null);
    if (validFen(t)) { setState((s) => ({ tree: newTree(t), node: undefined, key: s.key + 1 })); setOpen(false); setText(""); return; }
    try {
      const { tree } = parsePgn(t);
      if (Object.keys(tree.nodes).length < 2 && !/FEN/.test(t)) throw new PgnError("aucun coup reconnu");
      setState((s) => ({ tree, node: tree.root, key: s.key + 1 }));
      setOpen(false); setText("");
    } catch (e) {
      setErr(e instanceof PgnError ? `PGN illisible : ${e.message}.` : "Ni une FEN ni un PGN valide.");
    }
  };
  const reset = () => {
    if (!window.confirm("Repartir de la position initiale ? L'analyse en cours sera effacée.")) return;
    setState((s) => ({ tree: newTree(), node: newTree().root, key: s.key + 1 }));
  };

  return (
    <main className="arena-app">
      <PageHeader title="Analyse" active="/analyse">
        <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-muted hover:text-text">📥 Importer</button>
        <button type="button" onClick={reset} className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-muted hover:text-text">↺ Nouvelle</button>
      </PageHeader>
      <div className="mx-auto max-w-[1400px] px-2 pb-8 sm:px-3 lg:px-6">
        {open && (
          <div className="panel mb-3 flex flex-col gap-2 p-3">
            <label htmlFor="imp" className="text-sm font-semibold">Coller une FEN (position) ou un PGN (partie, variantes comprises)</label>
            <textarea id="imp" value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false}
              placeholder={"ex. rnbqkb1r/pppp1ppp/5n2/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3\nou 1. e4 e5 2. Nf3 (2. Bc4 Nf6) 2... Nc6 3. Bb5 *"}
              className="w-full rounded-lg border border-line bg-surface-2 p-2 font-mono text-xs" />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={load} className="neon-btn rounded-lg px-4 py-2 text-sm font-semibold">Charger</button>
              <button type="button" onClick={() => { setOpen(false); setErr(null); }} className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Annuler</button>
              {err && <p role="alert" className="text-sm text-danger">{err}</p>}
            </div>
            <p className="text-[11px] text-muted">Astuce : sur Lichess ou Chess.com, « Partager » → copier le PGN ou la FEN, puis colle-le ici.</p>
          </div>
        )}
        <AnalysisBoard
          key={state.key}
          wide
          initialTree={state.tree}
          initialNode={state.node}
          resetKey={state.key}
          storageKey="arena.analysis.free"
          footer={(x) => <ShareLink ctx={x} />}
        />
        <p className="mt-3 text-center text-xs text-muted">
          Pour analyser une de tes parties : <a href="/history" className="text-neon underline">Mes parties</a> (même tableau, avec le bilan de précision).
        </p>
      </div>
    </main>
  );
}

/** Lien vers cette analyse (position de départ + coups jusqu'à la position affichée). */
function ShareLink({ ctx }: { ctx: AnalysisCtx }) {
  const [msg, setMsg] = useState<string | null>(null);
  const share = async () => {
    const q = new URLSearchParams();
    const root = ctx.tree.nodes[ctx.tree.root]!.fen;
    if (root !== START_FEN) q.set("fen", root);
    const m = ucisTo(ctx.tree, ctx.nodeId);
    if (m.length) q.set("m", m.join(","));
    const url = `${window.location.origin}/analyse${q.size ? `?${q}` : ""}`;
    try {
      if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) { await navigator.share({ title: "Analyse", url }); setMsg("Partagé ✓"); }
      else { await navigator.clipboard.writeText(url); setMsg("Lien copié ✓"); }
    } catch { setMsg(url); }
    setTimeout(() => setMsg(null), 4000);
  };
  return (
    <div className="panel flex flex-wrap items-center gap-2 p-3">
      <button type="button" onClick={() => void share()} className="rounded-lg border border-neon/50 px-3 py-1.5 text-sm font-semibold text-neon hover:bg-neon/10">🔗 Partager cette position</button>
      {msg && <span role="status" className="break-all text-xs text-muted">{msg}</span>}
      <span className="text-[11px] text-muted">Le lien ouvre l'analyse sur cette ligne.</span>
    </div>
  );
}
