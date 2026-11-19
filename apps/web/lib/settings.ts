"use client";
import { useCallback, useEffect, useState } from "react";
import {
  defaultPaletteFor, isBoardTheme, isPalette, isPieceSet, type BoardThemeId, type PaletteId, type PieceSetId,
} from "./boardThemes";
import { sound } from "./sound";

/** Préférences locales du joueur (apparence, son). Stockage best-effort : tout marche sans. */
export interface Settings {
  /** échiquier (cases) */
  boardTheme: BoardThemeId;
  /** forme des pièces */
  pieceSet: PieceSetId;
  /** couleurs des pièces */
  palette: PaletteId;
  soundOn: boolean;
  volume: number;
  coordinates: boolean;
  /** interface : « arena » (sombre), « sobre » (claire, calme) ou « auto » (suit le réglage de l'appareil) */
  ui: "arena" | "sobre" | "auto";
  /** texte plus grand partout */
  largeText: boolean;
  /** promotion automatique en dame (sans fenêtre de choix) */
  autoQueen: boolean;
  /** son + vibration quand il reste peu de temps (seuil selon la cadence) */
  timeAlert: boolean;
  /** date du dernier changement (ms) : la version la plus récente gagne entre les appareils */
  updatedAt: number;
}

const KEY = "arena.settings.v1";
export const DEFAULT_SETTINGS: Settings = { boardTheme: "cyberpunk", pieceSet: "arena", palette: "neon", soundOn: true, volume: 0.7, coordinates: true, ui: "arena", largeText: false, autoQueen: false, timeAlert: true, updatedAt: 0 };

/** Préréglage « Classique sobre » : échiquier marron, pièces classiques ivoire et ébène, interface claire. */
export const SOBER_PRESET: Partial<Settings> = { ui: "sobre", boardTheme: "brown", pieceSet: "classic", palette: "ivory", coordinates: true };
/** Préréglage d'origine. */
export const ARENA_PRESET: Partial<Settings> = { ui: "arena", boardTheme: "cyberpunk", pieceSet: "arena", palette: "neon" };

export function parseSettings(raw: string | null): Settings {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    const boardTheme = isBoardTheme(v.boardTheme) ? v.boardTheme : DEFAULT_SETTINGS.boardTheme;
    return {
      boardTheme,
      pieceSet: isPieceSet(v.pieceSet) ? v.pieceSet : DEFAULT_SETTINGS.pieceSet,
      // anciens réglages (un seul thème) : les pièces gardent les couleurs qu'elles avaient
      palette: isPalette(v.palette) ? v.palette : defaultPaletteFor(boardTheme),
      soundOn: typeof v.soundOn === "boolean" ? v.soundOn : DEFAULT_SETTINGS.soundOn,
      volume: typeof v.volume === "number" && v.volume >= 0 && v.volume <= 1 ? v.volume : DEFAULT_SETTINGS.volume,
      coordinates: typeof v.coordinates === "boolean" ? v.coordinates : DEFAULT_SETTINGS.coordinates,
      ui: v.ui === "sobre" || v.ui === "auto" ? v.ui : "arena",
      largeText: v.largeText === true,
      autoQueen: v.autoQueen === true,
      timeAlert: v.timeAlert !== false,
      updatedAt: typeof v.updatedAt === "number" && v.updatedAt > 0 && Number.isFinite(v.updatedAt) ? v.updatedAt : 0,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** L'interface affichée est-elle claire ? (« auto » : selon le réglage clair / sombre de l'appareil) */
export function isLight(ui: Settings["ui"]): boolean {
  if (ui === "sobre") return true;
  if (ui === "arena") return false;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches === true;
}

// Une seule source de vérité par onglet : le panneau « Apparence » et tous les plateaux de la page restent synchronisés.
let current: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

/** Applique de nouveaux réglages : mémoire de l'onglet, stockage local, tous les composants abonnés. */
function commit(next: Settings): void {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  for (const l of listeners) l(next);
}

// ─── Synchronisation avec le compte : mêmes réglages sur l'ordinateur et le téléphone ──
let synced = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function pushSoon(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: load() }) }).catch(() => {});
  }, 800);
}

/** Une fois par onglet : la version la plus récente (cet appareil ou le compte) l'emporte. */
function syncOnce(): void {
  if (synced || typeof window === "undefined") return;
  synced = true;
  if (window.location.pathname === "/" || window.location.pathname === "/conditions") return; // pas encore connecté
  void fetch("/api/settings", { cache: "no-store" })
    .then(async (r) => (r.ok ? ((await r.json()) as { data: unknown }) : null))
    .then((d) => {
      if (!d) return;
      const local = load();
      const srv = d.data && typeof d.data === "object" ? parseSettings(JSON.stringify(d.data)) : null;
      if (srv && srv.updatedAt > local.updatedAt) commit(srv);
      else if (local.updatedAt > 0 && (!srv || local.updatedAt > srv.updatedAt)) pushSoon();
    })
    .catch(() => {});
}

function load(): Settings {
  if (current) return current;
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* stockage indisponible */ }
  current = parseSettings(raw);
  return current;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSettings(load());
    setLoaded(true);
    listeners.add(setSettings);
    syncOnce();
    return () => { listeners.delete(setSettings); };
  }, []);
  // interface sobre / texte plus grand : posés sur <html> (le script du layout le fait déjà avant l'affichage)
  useEffect(() => {
    if (!loaded) return; // pas d'effacement avant lecture des réglages (sinon flash)
    const el = document.documentElement;
    if (settings.largeText) el.dataset.text = "large"; else delete el.dataset.text;
    const apply = () => { if (isLight(settings.ui)) el.dataset.ui = "sobre"; else delete el.dataset.ui; };
    apply();
    if (settings.ui !== "auto") return;
    // mode automatique : suit le passage jour / nuit de l'appareil en direct
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [loaded, settings.ui, settings.largeText]);
  useEffect(() => {
    sound.setMuted(!settings.soundOn);
    sound.setVolume(settings.volume);
  }, [settings.soundOn, settings.volume]);
  const update = useCallback((patch: Partial<Settings>) => {
    commit({ ...load(), ...patch, updatedAt: Date.now() });
    pushSoon(); // sans compte (page de connexion), le serveur refuse : sans conséquence
  }, []);
  return [settings, update] as const;
}
