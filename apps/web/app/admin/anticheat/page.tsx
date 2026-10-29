"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Chessboard } from "react-chessboard";
import type { CaseDetail, CaseResolution, CaseSummary, DecisionResult } from "@chessarena/shared";
import { EvalChart } from "../../../components/admin/EvalChart";
import { MoveTable } from "../../../components/admin/MoveTable";
import { colorName, fensFromPgn, formatCents, formatMs, suspectSummary } from "../../../lib/anticheatView";

/**
 * Back-office d'arbitrage anti-triche.
 * Gauche : file des dossiers (blocages d'abord, puis par score).
 * Droite : dossier sélectionné — parties analysées, courbe d'éval Stockfish,
 * pertes et temps coup par coup, position, historique, décision.
 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/${path}`, { cache: "no-store", ...init });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

const STATE_LABEL: Record<string, string> = {
  active: "actif", withdrawal_hold: "retraits bloqués", suspended: "suspendu", self_excluded: "auto-exclu", closed: "fermé",
};

export default function AnticheatPage() {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const list = await api<CaseSummary[]>(`anticheat/cases?status=${tab}`);
      setCases(list);
      setSelected((s) => s ?? list[0]?.id ?? null);
    } catch (e) { setError((e as Error).message); }
  }, [tab]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (!selected) return setDetail(null);
    setDetail(null);
    api<CaseDetail>(`anticheat/cases/${selected}`).then(setDetail, (e) => setError((e as Error).message));
  }, [selected]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-[1400px] flex-col gap-4 px-4 py-6 lg:flex-row">
      <aside className="w-full shrink-0 lg:w-80">
        <h1 className="mb-3 text-lg font-bold">Anti-triche — arbitrage</h1>
        <div className="mb-3 flex gap-1 rounded-md bg-neutral-100 p-1 text-sm dark:bg-neutral-900">
          {(["open", "resolved"] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); setSelected(null); }}
              className={`flex-1 rounded px-2 py-1 ${tab === t ? "bg-white font-semibold shadow-sm dark:bg-neutral-800" : ""}`}>
              {t === "open" ? "À traiter" : "Clos"}
            </button>
          ))}
        </div>
        {cases === null && <p className="text-sm text-neutral-500">Chargement…</p>}
        {cases?.length === 0 && <p className="text-sm text-neutral-500">Aucun dossier.</p>}
        <ul className="flex flex-col gap-2">
          {cases?.map((c) => (
            <li key={c.id}>
              <button onClick={() => setSelected(c.id)}
                className={`w-full rounded-lg border p-3 text-left text-sm transition ${selected === c.id ? "border-blue-600 ring-1 ring-blue-600" : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{c.userId}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${c.level === "hold" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"}`}>
                    {c.level === "hold" ? "BLOCAGE" : "SURVEILLANCE"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">score {c.score} · {c.gamesCount} parties analysées{c.pendingWithdrawalCents > 0 ? ` · ${formatCents(c.pendingWithdrawalCents, "EUR")} en retrait` : ""}</p>
                {c.resolution && <p className="mt-1 text-xs">Décision : <b>{c.resolution}</b></p>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="min-w-0 flex-1">
        {error && <p role="alert" className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{error}</p>}
        {!detail && selected && <p className="text-sm text-neutral-500">Chargement du dossier…</p>}
        {detail && <CaseView key={detail.id} detail={detail} onDecided={() => { setSelected(null); void loadList(); }} />}
      </section>
    </main>
  );
}

function CaseView({ detail, onDecided }: { detail: CaseDetail; onDecided: () => void }) {
  const [gameIdx, setGameIdx] = useState(0);
  const [ply, setPly] = useState<number | null>(null);
  const game = detail.games[gameIdx];
  const fens = useMemo(() => (game ? fensFromPgn(game.pgn) : []), [game]);
  const summary = game ? suspectSummary(game) : null;
  useEffect(() => setPly(null), [gameIdx]);

  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold">{detail.userId}</h2>
          <p className="text-sm text-neutral-500">
            compte : <b>{STATE_LABEL[detail.accountState] ?? detail.accountState}</b> · ouvert le {new Date(detail.createdAt).toLocaleString("fr-FR")}
          </p>
        </div>
        <ul className="mt-2 list-disc pl-5 text-sm">
          {detail.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </header>

      {detail.games.length === 0 ? <p className="text-sm text-neutral-500">Aucune analyse disponible.</p> : (
        <>
          <nav className="flex flex-wrap gap-2" aria-label="Parties">
            {detail.games.map((g, i) => (
              <button key={g.gameId} onClick={() => setGameIdx(i)}
                className={`rounded-md border px-2.5 py-1.5 text-left text-xs ${i === gameIdx ? "border-blue-600 bg-blue-50 dark:bg-blue-950" : "border-neutral-200 dark:border-neutral-800"}`}>
                <span className="font-semibold">{g.isTrigger ? "⚑ " : ""}vs {g.opponent}</span>
                <span className="block text-neutral-500">ACPL {g.acpl.toFixed(1)} · {(g.engineMatchRate * 100).toFixed(0)} % · {g.result}</span>
              </button>
            ))}
          </nav>

          {game && summary && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="ACPL" value={game.acpl.toFixed(1)} hint={`${game.analysedMoves} coups retenus`} />
                <Stat label="Coïncidence moteur" value={`${(game.engineMatchRate * 100).toFixed(1)} %`} hint={`série max ${summary.longestMatchStreak}`} />
                <Stat label="Gaffes / erreurs" value={`${summary.blunders} / ${summary.mistakes}`} />
                <Stat label="Temps moyen" value={formatMs(game.timeMeanMs)} hint={`CV ${game.timeCv.toFixed(2)}`} />
                <Stat label="Pertes de focus" value={String(game.focusLoss)} />
                <Stat label="Analyse" value={`prof. ${game.depth}`} hint={game.engine} />
              </div>
              <p className="text-xs text-neutral-500">
                {colorName(game.color)} · Elo {game.ratingAtGame} · {game.timeControl} · {game.buyInCents > 0 ? formatCents(game.buyInCents, game.currency) : "gratuite"} · {game.termination} · {new Date(game.endedAt).toLocaleString("fr-FR")}
              </p>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex min-w-0 flex-col gap-3">
                  <EvalChart moves={game.moves} suspectColor={game.color} selectedPly={ply} onSelect={setPly} />
                  <MoveTable moves={game.moves} suspectColor={game.color} selectedPly={ply} onSelect={setPly} />
                </div>
                <div className="flex flex-col gap-2">
                  <Chessboard id="review-board" position={fens[ply === null ? fens.length - 1 : ply + 1] ?? "start"}
                    boardOrientation={game.color === "w" ? "white" : "black"} arePiecesDraggable={false} animationDuration={0} />
                  <p className="text-center text-xs text-neutral-500">{ply === null ? "Position finale" : `Après le demi-coup ${ply + 1}`} — cliquez un coup ou le graphique</p>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {detail.decisions.length > 0 && (
        <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h3 className="mb-2 font-semibold">Historique</h3>
          <ol className="flex flex-col gap-1">
            {detail.decisions.map((d, i) => (
              <li key={i}><span className="text-neutral-500">{new Date(d.createdAt).toLocaleString("fr-FR")}</span> — <b>{d.action}</b> par {d.actor}{d.note ? ` : « ${d.note} »` : ""}</li>
            ))}
          </ol>
        </section>
      )}

      {detail.status === "open" && <DecisionPanel caseId={detail.id} onDecided={onDecided} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="truncate text-[11px] text-neutral-500" title={hint}>{hint}</p>}
    </div>
  );
}

function DecisionPanel({ caseId, onDecided }: { caseId: string; onDecided: () => void }) {
  const [note, setNote] = useState("");
  const [confirmCheat, setConfirmCheat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const valid = note.trim().length >= 5;

  const decide = async (decision: CaseResolution) => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api<DecisionResult>(`anticheat/cases/${caseId}/decision`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, note }),
      }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <section className="rounded-lg border border-emerald-600 p-4 text-sm">
        <p className="font-semibold">Décision enregistrée : {result.decision}</p>
        {result.decision === "cheat" && (
          <ul className="mt-2 list-disc pl-5">
            <li>{result.refunds.length} adversaire(s) remboursé(s) : {result.refunds.map((r) => `${r.userId} ${formatCents(r.amountCents, r.currency)}`).join(", ") || "—"}</li>
            <li>Confisqué : {Object.entries(result.confiscated).map(([c, v]) => formatCents(v!, c)).join(", ") || "rien"}</li>
            <li>{result.cancelledWithdrawals} retrait(s) annulé(s)</li>
          </ul>
        )}
        {result.decision !== "cheat" && <p className="mt-1">{result.releasedWithdrawals} retrait(s) libéré(s).</p>}
        <button className="mt-3 rounded-md border px-3 py-1.5" onClick={onDecided}>Dossier suivant</button>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h3 className="mb-2 font-semibold">Décision</h3>
      <label className="text-sm" htmlFor="note">Motif (obligatoire, conservé au journal d'audit)</label>
      <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={3}
        className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700"
        placeholder="Ex. : coïncidence moteur 92 % sur 3 parties, temps de réflexion quasi constants, aucun coup humain identifiable." />
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={!valid || busy} onClick={() => decide("clean")} className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Approuver (clean)</button>
        <button disabled={!valid || busy} onClick={() => decide("watch")} className="rounded-md border border-amber-600 px-3 py-2 text-sm font-semibold text-amber-700 disabled:opacity-40 dark:text-amber-300">Garder sous surveillance</button>
        {!confirmCheat ? (
          <button disabled={!valid || busy} onClick={() => setConfirmCheat(true)} className="rounded-md border border-red-600 px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-40 dark:text-red-300">Confirmer la triche…</button>
        ) : (
          <span className="flex flex-wrap items-center gap-2 rounded-md bg-red-50 p-2 text-sm dark:bg-red-950">
            Bannissement, confiscation du solde et remboursement des adversaires. Irréversible.
            <button disabled={busy} onClick={() => decide("cheat")} className="rounded-md bg-red-600 px-3 py-1.5 font-semibold text-white">Confirmer</button>
            <button onClick={() => setConfirmCheat(false)} className="rounded-md border px-3 py-1.5">Annuler</button>
          </span>
        )}
      </div>
    </section>
  );
}
