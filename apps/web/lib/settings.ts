"use client";
import { useCallback, useEffect, useState } from "react";
import { isBoardTheme, type BoardThemeId } from "./boardThemes";
import { sound } from "./sound";

/** Préférences locales du joueur (thème, son). Stockage best-effort : tout marche sans. */
export interface Settings {
  boardTheme: BoardThemeId;
  soundOn: boolean;
  volume: number;
  coordinates: boolean;
}

const KEY = "arena.settings.v1";
export const DEFAULT_SETTINGS: Settings = { boardTheme: "cyberpunk", soundOn: true, volume: 0.7, coordinates: true };

export function parseSettings(raw: string | null): Settings {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    return {
      boardTheme: isBoardTheme(v.boardTheme) ? v.boardTheme : DEFAULT_SETTINGS.boardTheme,
      soundOn: typeof v.soundOn === "boolean" ? v.soundOn : DEFAULT_SETTINGS.soundOn,
      volume: typeof v.volume === "number" && v.volume >= 0 && v.volume <= 1 ? v.volume : DEFAULT_SETTINGS.volume,
      coordinates: typeof v.coordinates === "boolean" ? v.coordinates : DEFAULT_SETTINGS.coordinates,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { /* stockage indisponible */ }
    setSettings(parseSettings(raw));
  }, []);
  useEffect(() => {
    sound.setMuted(!settings.soundOn);
    sound.setVolume(settings.volume);
  }, [settings.soundOn, settings.volume]);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* best-effort */ }
      return next;
    });
  }, []);
  return [settings, update] as const;
}
