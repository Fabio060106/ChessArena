"use client";
import { useEffect, useRef, useState } from "react";
import { CHAT_MAX_LENGTH, type ChatAck, type ChatMessage } from "@chessarena/shared";
import { CHAT_ERRORS, chatTime } from "../lib/chat";

interface Props {
  messages: readonly ChatMessage[];
  me: string;
  /** absent = lecture seule */
  onSend?: (text: string) => Promise<ChatAck>;
  placeholder?: string;
  empty?: string;
  /** messages rapides (un clic) */
  quick?: readonly string[];
  /** hauteur de la zone des messages */
  height?: string;
  /** signaler un message à l'organisateur */
  onReport?: (m: ChatMessage) => Promise<boolean>;
}

/** Chat d'une partie : messages défilants, saisie limitée à 200 caractères, messages rapides. */
export function ChatPanel({ messages, me, onSend, placeholder = "Écrire un message…", empty = "Aucun message.", quick, height = "h-56", onReport }: Props) {
  // joueurs masqués (sur cet écran) et messages déjà signalés
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [reported, setReported] = useState<Set<number>>(new Set());
  const shown = messages.filter((m) => !hidden.has(m.userId));
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // reste collé en bas, sauf si l'utilisateur est remonté lire l'historique
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const nearBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
    if (nearBottom || messages.at(-1)?.userId === me) b.scrollTop = b.scrollHeight;
  }, [messages, me]);

  const send = async (raw: string) => {
    const t = raw.trim();
    if (!t || !onSend || sending) return;
    setSending(true);
    const r = await onSend(t);
    setSending(false);
    if (r.ok) { setText(""); setError(null); } else setError(CHAT_ERRORS[r.code] || "Message refusé.");
  };

  return (
    <div className="flex flex-col gap-2">
      <div ref={box} className={`${height} overflow-y-auto rounded-lg bg-ink/60 p-2 text-sm`} aria-live="polite" aria-label="Messages">
        {shown.length === 0 ? <p className="p-1 text-xs text-muted">{empty}</p> : shown.map((m) => (
          <p key={m.id} className="group break-words py-0.5 leading-snug">
            <span className="tabular mr-1.5 text-[10px] text-muted/70">{chatTime(m.at)}</span>
            <a href={`/profil/${encodeURIComponent(m.userId)}`} target="_blank" rel="noreferrer"
              className={`mr-1 font-semibold hover:underline ${m.userId === me ? "text-neon" : "text-gold"}`}>{m.userId}</a>
            <span className="text-text">{m.text}</span>
            {m.userId !== me && (
              <span className="ml-1.5 inline-flex gap-1 align-middle opacity-40 transition group-hover:opacity-100">
                {onReport && (
                  <button type="button" disabled={reported.has(m.id)} title="Signaler ce message à l'organisateur" aria-label={`Signaler le message de ${m.userId}`}
                    onClick={() => void onReport(m).then((ok) => { if (ok) setReported((r) => new Set(r).add(m.id)); })}
                    className="text-[11px] text-muted hover:text-danger disabled:text-danger">{reported.has(m.id) ? "signalé ✓" : "⚑"}</button>
                )}
                <button type="button" title={`Masquer les messages de ${m.userId}`} aria-label={`Masquer les messages de ${m.userId}`}
                  onClick={() => setHidden((h) => new Set(h).add(m.userId))} className="text-[11px] text-muted hover:text-text">🔇</button>
              </span>
            )}
          </p>
        ))}
      </div>
      {hidden.size > 0 && (
        <p className="text-xs text-muted">
          Messages masqués : {[...hidden].join(", ")} · <button type="button" className="text-neon hover:underline" onClick={() => setHidden(new Set())}>tout réafficher</button>
        </p>
      )}
      {onSend && (
        <>
          {quick && quick.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {quick.map((q) => (
                <button key={q} type="button" disabled={sending} onClick={() => void send(q)}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted hover:text-text disabled:opacity-50">{q}</button>
              ))}
            </div>
          )}
          <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            <input value={text} onChange={(e) => { setText(e.target.value); setError(null); }} maxLength={CHAT_MAX_LENGTH}
              placeholder={placeholder} aria-label="Message"
              className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-2.5 py-2 text-sm outline-none focus:border-neon/60" />
            <button type="submit" disabled={sending || !text.trim()} className="neon-btn rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50">Envoyer</button>
          </form>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </>
      )}
    </div>
  );
}
