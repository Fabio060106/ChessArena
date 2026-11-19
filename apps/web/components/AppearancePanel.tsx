"use client";
import { useEffect, useState, type CSSProperties } from "react";
import {
  BOARD_THEMES, PALETTE_ORDER, PIECE_PALETTES, PIECE_SETS, THEME_ORDER, boardVars,
} from "../lib/boardThemes";
import { ARENA_PRESET, DEFAULT_SETTINGS, SOBER_PRESET, useSettings } from "../lib/settings";
import { GameBoard } from "./GameBoard";
import { PieceSvg } from "./Pieces";

/** Position d'exemple : toutes les pièces, un coup joué, une case en surbrillance. */
const PREVIEW_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";

/** Bouton « 🎨 Apparence » : ouvre le panneau de personnalisation. */
export function AppearanceButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Échiquier, pièces et couleurs"
        className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-text ${className}`}>
        🎨 Apparence
      </button>
      {open && <AppearancePanel onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Personnalisation : l'échiquier, la forme des pièces et leurs couleurs se choisissent séparément
 * (on peut aimer l'échiquier d'un thème et les pièces d'un autre). Aperçu en direct ; réglages gardés sur cet appareil.
 */
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const [s, update] = useSettings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = "ring-2 ring-neon";
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-2 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label="Apparence de l'échiquier"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel flex max-h-[94dvh] w-full max-w-[860px] flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="font-display text-lg font-bold">Apparence</h2>
          <button type="button" onClick={onClose} className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted hover:text-text" aria-label="Fermer">Fermer ✕</button>
        </div>
        <div className="grid gap-4 overflow-y-auto p-4 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="flex flex-col gap-2 md:sticky md:top-0 md:self-start">
            <div className="mx-auto w-full max-w-[260px]">
              <GameBoard fen={PREVIEW_FEN} serverFen={PREVIEW_FEN} orientation="w" myColor="w" interactive={false} myTurn={false}
                lastMove="d1h5" premoves={[]} theme={s.boardTheme} pieceSet={s.pieceSet} palette={s.palette} coordinates={s.coordinates}
                onMove={() => false} onCancelPremoves={() => {}} />
            </div>
            <p className="text-center text-xs text-muted">
              {BOARD_THEMES[s.boardTheme].label} · {PIECE_SETS.find((x) => x.id === s.pieceSet)?.label} · {PIECE_PALETTES[s.palette].label}
            </p>
            <label className="flex items-center justify-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={s.coordinates} onChange={(e) => update({ coordinates: e.target.checked })} /> Coordonnées (a-h, 1-8)
            </label>
            <button type="button" className="text-xs text-muted underline hover:text-text"
              onClick={() => update({ boardTheme: DEFAULT_SETTINGS.boardTheme, pieceSet: DEFAULT_SETTINGS.pieceSet, palette: DEFAULT_SETTINGS.palette, ui: DEFAULT_SETTINGS.ui, largeText: false })}>
              Revenir à l'apparence d'origine
            </button>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <section aria-label="Préréglages">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">En un clic</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => update(SOBER_PRESET)}
                  className={`rounded-lg border p-3 text-left hover:bg-surface-2 ${s.ui === "sobre" && s.boardTheme === "brown" && s.pieceSet === "classic" ? "border-neon ring-2 ring-neon" : "border-line"}`}>
                  <span className="block font-semibold">Classique sobre</span>
                  <span className="block text-xs text-muted">Interface claire et calme, échiquier marron, pièces traditionnelles. Idéal si les couleurs vives gênent.</span>
                </button>
                <button type="button" onClick={() => update(ARENA_PRESET)}
                  className={`rounded-lg border p-3 text-left hover:bg-surface-2 ${s.ui === "arena" && s.boardTheme === "cyberpunk" && s.pieceSet === "arena" ? "border-neon ring-2 ring-neon" : "border-line"}`}>
                  <span className="block font-semibold">Arena (d'origine)</span>
                  <span className="block text-xs text-muted">Interface sombre, néons, style e-sport.</span>
                </button>
              </div>
              <div className="mt-3 flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Thème de l'interface">
                  <span>Thème :</span>
                  {([["arena", "🌙 Sombre"], ["sobre", "☀️ Clair"], ["auto", "🖥 Automatique"]] as const).map(([v, label]) => (
                    <button key={v} type="button" role="radio" aria-checked={s.ui === v} onClick={() => update({ ui: v })}
                      className={`rounded-lg border px-2.5 py-1 text-sm ${s.ui === v ? "border-neon bg-neon/10 font-semibold" : "border-line hover:bg-surface-2"}`}>{label}</button>
                  ))}
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4" checked={s.largeText} onChange={(e) => update({ largeText: e.target.checked })} />
                  Texte plus grand
                </label>
              </div>
            </section>

            <section aria-label="Pendant la partie">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Pendant la partie</h3>
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4" checked={s.autoQueen} onChange={(e) => update({ autoQueen: e.target.checked })} />
                  <span>Promotion automatique en dame <span className="block text-xs text-muted">Un pion qui arrive au bout devient dame directement, sans fenêtre de choix.</span></span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4" checked={s.timeAlert} onChange={(e) => update({ timeAlert: e.target.checked })} />
                  <span>Alerte quand il reste peu de temps <span className="block text-xs text-muted">Son, vibration et pendule qui clignote : sous 10 s en bullet, 20 s en blitz, 30 s en rapide.</span></span>
                </label>
              </div>
            </section>

            <section aria-label="Échiquier">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Échiquier</h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                {THEME_ORDER.map((id) => {
                  const v = BOARD_THEMES[id].vars;
                  return (
                    <button key={id} type="button" aria-pressed={s.boardTheme === id} onClick={() => update({ boardTheme: id })}
                      className={`flex flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-surface-2 ${s.boardTheme === id ? pick : ""}`}>
                      <span className="grid size-14 grid-cols-4 overflow-hidden rounded-md" aria-hidden>
                        {Array.from({ length: 16 }, (_, i) => (
                          <span key={i} style={{ background: ((i >> 2) + i) % 2 === 0 ? v["--sq-light"] : v["--sq-dark"] }} />
                        ))}
                      </span>
                      <span className="text-[11px] text-muted">{BOARD_THEMES[id].label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section aria-label="Forme des pièces">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Pièces</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PIECE_SETS.map((ps) => (
                  <button key={ps.id} type="button" aria-pressed={s.pieceSet === ps.id} onClick={() => update({ pieceSet: ps.id })}
                    className={`flex flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-surface-2 ${s.pieceSet === ps.id ? pick : ""}`}>
                    <span className="flex rounded-md px-1" style={{ ...(boardVars(s.boardTheme, s.palette) as CSSProperties), background: "var(--sq-light)" }} aria-hidden>
                      {(["wk", "wn", "bq", "bp"] as const).map((c) => <span key={c} className="size-9"><PieceSvg code={c} set={ps.id} /></span>)}
                    </span>
                    <span className="text-[11px] text-muted">{ps.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <section aria-label="Couleurs des pièces">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Couleurs des pièces</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PALETTE_ORDER.map((id) => {
                  const v = PIECE_PALETTES[id].vars;
                  const disc = (c: "w" | "b") => ({
                    background: `linear-gradient(160deg, ${v[`--p${c}-0`]}, ${v[`--p${c}-1`]})`,
                    boxShadow: `inset 0 0 0 2px ${v[`--p${c}-stroke`]}`,
                  });
                  return (
                    <button key={id} type="button" aria-pressed={s.palette === id} onClick={() => update({ palette: id })}
                      className={`flex flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-surface-2 ${s.palette === id ? pick : ""}`}>
                      <span className="flex gap-1 rounded-md bg-surface-2 px-2 py-1.5" aria-hidden>
                        <span className="size-7 rounded-full" style={disc("w")} />
                        <span className="size-7 rounded-full" style={disc("b")} />
                      </span>
                      <span className="text-[11px] text-muted">{PIECE_PALETTES[id].label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            <p className="text-[11px] text-muted/80">Tes choix sont gardés sur cet appareil et s'appliquent partout : parties, analyse, répertoire, parties en direct.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
