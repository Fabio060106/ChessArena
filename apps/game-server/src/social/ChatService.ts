import { CHAT_MAX_LENGTH, type ChatChannel, type ChatMessage } from "@chessarena/shared";
import { TokenBucket } from "../net/rateLimiter.js";

/** Messages conservés par partie et par canal (historique envoyé à la reconnexion / à l'arrivée d'un spectateur). */
const KEEP = 60;
/** Durée de vie de l'historique après la fin de la partie (chat d'après-partie, revanche). */
const TTL_AFTER_END_MS = 10 * 60_000;

export type ChatError = "EMPTY" | "TOO_LONG" | "RATE_LIMITED";

/**
 * Nettoie un message : caractères de contrôle et invisibles retirés, espaces regroupés.
 * Le rendu (React) échappe le HTML ; ici on borne la taille et on évite les messages « vides ».
 */
export function cleanChatText(raw: unknown): string | ChatError {
  if (typeof raw !== "string") return "EMPTY";
  if (raw.length > CHAT_MAX_LENGTH * 4) return "TOO_LONG";
  const text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "EMPTY";
  if ([...text].length > CHAT_MAX_LENGTH) return "TOO_LONG";
  return text;
}

/**
 * Chat des parties, en mémoire (éphémère comme sur Lichess : rien n'est stocké en base).
 * Limite : 5 messages d'affilée, puis 1 toutes les 2 s, par joueur.
 */
export class ChatService {
  private readonly logs = new Map<string, { players: ChatMessage[]; spectators: ChatMessage[]; expires: number | null }>();
  private readonly buckets = new Map<string, { b: TokenBucket; seen: number }>();
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  post(gameId: string, channel: ChatChannel, userId: string, raw: unknown): ChatMessage | ChatError {
    const text = cleanChatText(raw);
    if (text === "EMPTY" || text === "TOO_LONG") return text;
    if (!this.bucket(userId).take()) return "RATE_LIMITED";
    const log = this.log(gameId);
    const m: ChatMessage = { id: ++this.seq, gameId, channel, userId, text, at: this.now() };
    const list = log[channel];
    list.push(m);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    return m;
  }

  history(gameId: string, channels: readonly ChatChannel[]): ChatMessage[] {
    const log = this.logs.get(gameId);
    if (!log) return [];
    return channels.flatMap((c) => log[c]).sort((a, b) => a.id - b.id);
  }

  /** Partie terminée : l'historique reste disponible un moment (chat d'après-partie), puis disparaît. */
  ended(gameId: string): void {
    const log = this.logs.get(gameId);
    if (log) log.expires = this.now() + TTL_AFTER_END_MS;
    this.sweep();
  }

  private log(gameId: string) {
    let l = this.logs.get(gameId);
    if (!l) this.logs.set(gameId, (l = { players: [], spectators: [], expires: null }));
    return l;
  }

  private bucket(userId: string): TokenBucket {
    const t = this.now();
    let e = this.buckets.get(userId);
    if (!e) this.buckets.set(userId, (e = { b: new TokenBucket(5, 0.5, this.now), seen: t }));
    e.seen = t;
    return e.b;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, l] of this.logs) if (l.expires !== null && l.expires < t) this.logs.delete(id);
    for (const [u, e] of this.buckets) if (t - e.seen > 10 * 60_000) this.buckets.delete(u);
  }
}
