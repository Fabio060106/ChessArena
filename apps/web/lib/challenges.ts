"use client";
import { useSyncExternalStore } from "react";
import type { ChallengeAck, ChallengeUpdate, ChallengeView, TimeControlId } from "@chessarena/shared";
import { getSocket, type AuthProvider, type ArenaSocket } from "./socket";
import { TC_LABEL } from "./social";
import { sound } from "./sound";

/** Messages des refus de défi, pour le joueur. */
export function challengeError(code: string | undefined, who?: string): string {
  const x = who ?? "Ce joueur";
  switch (code) {
    case "OFFLINE": return `${x} n'est pas connecté en ce moment.`;
    case "OPPONENT_BUSY": return `${x} est déjà en partie.`;
    case "IN_GAME": return "Tu as déjà une partie en cours.";
    case "IN_TOURNAMENT": return "Tu es dans un tournoi en cours.";
    case "NOT_FOUND": return "Joueur introuvable.";
    case "SELF": return "Tu ne peux pas te défier toi-même.";
    case "EXPIRED": return "Ce défi n'est plus valable.";
    default: return "Défi impossible pour l'instant, réessaie dans un instant.";
  }
}

/** Texte d'un défi terminé, vu par celui qui l'a envoyé. */
export function outcomeText(u: ChallengeUpdate, to: string): string | null {
  if (u.status === "declined") return `${to} a refusé le défi.`;
  if (u.status === "expired") return `${to} n'a pas répondu à temps.`;
  if (u.status === "cancelled" && u.reason) return challengeError(u.reason === "IN_GAME" ? "OPPONENT_BUSY" : u.reason, to);
  return null;
}

interface State {
  incoming: ChallengeView[];
  outgoing: ChallengeView | null;
  notice: string | null;
}

let state: State = { incoming: [], outgoing: null, notice: null };
const listeners = new Set<() => void>();
let socket: ArenaSocket | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function notify(text: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  set({ notice: text });
  noticeTimer = setTimeout(() => set({ notice: null }), 6000);
}

/** Branche le socket une fois par onglet : défis reçus, réponses aux défis envoyés. */
export function initChallenges(getAuth: AuthProvider): void {
  if (socket) return;
  socket = getSocket(getAuth);
  socket.on("challenge:incoming", (c) => {
    if (state.incoming.some((x) => x.id === c.id)) return;
    set({ incoming: [...state.incoming, c] });
    sound.play("start");
  });
  socket.on("challenge:update", (u) => {
    const mine = state.outgoing?.id === u.id ? state.outgoing : null;
    set({ incoming: state.incoming.filter((x) => x.id !== u.id), outgoing: mine ? null : state.outgoing });
    if (u.status === "accepted") {
      // la partie commence : la page de jeu la reprend automatiquement
      if (window.location.pathname !== "/play") window.location.href = "/play";
      return;
    }
    if (mine) {
      const t = outcomeText(u, mine.to);
      if (t) notify(t);
    }
  });
}

export function sendChallenge(to: string, timeControl: TimeControlId): Promise<string | null> {
  return new Promise((resolve) => {
    if (!socket) return resolve(challengeError(undefined));
    const t = setTimeout(() => resolve("Le serveur ne répond pas (il se réveille peut-être) : réessaie dans une minute."), 15_000);
    socket.emit("challenge:send", { to, timeControl }, (r: ChallengeAck) => {
      clearTimeout(t);
      if (!r.ok) return resolve(challengeError(r.code, to));
      set({ outgoing: r.challenge });
      resolve(null);
    });
  });
}

export function cancelChallenge(): void {
  const c = state.outgoing;
  if (!c || !socket) return;
  socket.emit("challenge:cancel", { id: c.id });
  set({ outgoing: null });
}

export function answerChallenge(id: string, accept: boolean): void {
  if (!socket) return;
  const c = state.incoming.find((x) => x.id === id);
  set({ incoming: state.incoming.filter((x) => x.id !== id) });
  socket.emit("challenge:answer", { id, accept }, (r) => {
    if (!r.ok && accept) notify(challengeError(r.code, c?.from));
  });
}

export function useChallenges(): State {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => state,
  );
}

export const challengeLabel = (tc: TimeControlId) => TC_LABEL[tc];
