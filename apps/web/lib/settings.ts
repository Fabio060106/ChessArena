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
  /** interface : « arena » (sombre, néons) ou « sobre » (claire, calme) */
  ui: "arena" | "sobre";
  /** texte plus grand partout */
  largeText: boolean;
}

const KEY = "arena.settings.v1";
export const DEFAULT_SETTINGS: Settings = { boardTheme: "cyberpunk", pieceSet: "arena", palette: "neon", soundOn: true, volume: 0.7, coordinates: true, ui: "arena", largeText: false };

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
      ui: v.ui === "sobre" ? "sobre" : "arena",
      largeText: v.largeText === true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Une seule source de vérité par onglet : le panneau « Apparence » et tous les plateaux de la page restent synchronisés.
let current: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

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
    return () => { listeners.delete(setSettings); };
  }, []);
  // interface sobre / texte plus grand : posés sur <html> (le script du layout le fait déjà avant l'affichage)
  useEffect(() => {
    if (!loaded) return; // pas d'effacement avant lecture des réglages (sinon flash)
    const el = document.documentElement;
    if (settings.ui === "sobre") el.dataset.ui = "sobre"; else delete el.dataset.ui;
    if (settings.largeText) el.dataset.text = "large"; else delete el.dataset.text;
  }, [loaded, settings.ui, settings.largeText]);
  useEffect(() => {
    sound.setMuted(!settings.soundOn);
    sound.setVolume(settings.volume);
  }, [settings.soundOn, settings.volume]);
  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...load(), ...patch };
    current = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* best-effort */ }
    for (const l of listeners) l(next);
  }, []);
  return [settings, update] as const;
}
