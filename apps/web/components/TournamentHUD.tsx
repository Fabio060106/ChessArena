"use client";
import { memo, useState } from "react";
import { SNG_MAX_SIZE, SNG_MIN_SIZE, type SngCreatePayload, type SngSnapshot, type TimeControlId } from "@chessarena/shared";
import { bracketInfo, currentPairings, fieldSize, formatMoney, liveStandings, prizeBreakdown, roundLabel, waitingInfo, type StandingRow } from "../lib/tournament";

const TC_LABEL: Record<TimeControlId, string> = {
  bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0",
};

/** Codes renvoyés par sng:register / sng:unregister (game-server). */
const SNG_ERRORS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Solde insuffisant pour cette entrée.",
  ALREADY_REGISTERED: "Vous êtes déjà inscrit à cette table.",
  IN_GAME: "Terminez votre partie en cours.",
  IN_TOURNAMENT: "Vous êtes déjà inscrit à un tournoi.",
  ALREADY_QUEUED: "Quittez la file d'attente avant de vous inscrire.",
  FULL: "Table complète : une nouvelle table s'ouvre.",
  BUSY: "Table en cours de démarrage, réessayez.",
  NOT_REGISTERING: "Les inscriptions sont closes.",
  NOT_REGISTERED: "Vous n'êtes pas inscrit à cette table.",
  UNKNOWN_FORMAT: "Format de tournoi introuvable.",
  UNKNOWN_TOURNAMENT: "Ce tournoi n'existe plus (terminé ou annulé).",
  ALREADY_CREATED: "Tu as déjà un tournoi en attente de joueurs.",
  TOO_MANY_OPEN: "Trop de tournois ouverts en ce moment, réessaie plus tard.",
  BAD_PAYLOAD: "Réglages du tournoi invalides.",
  NOT_ENOUGH_PLAYERS: "Il faut au moins 2 inscrits pour lancer le tournoi.",
  NOT_CREATOR: "Seul le créateur peut lancer le tournoi.",
  RATE_LIMITED: "Trop d'actions, ralentissez.",
  REAL_MONEY_DISABLED: "Argent réel indisponible : tables en jetons uniquement.",
  JURISDICTION_BLOCKED: "Argent réel non autorisé dans votre pays.",
  SELF_EXCLUDED: "Auto-exclusion en cours.",
  LIMIT_EXCEEDED: "Cette entrée dépasse une de vos limites de jeu.",
};

interface Props {
  userId: string;
  current: SngSnapshot | null;
  lobby: SngSnapshot[];
  busy: string | null;
  error: string | null;
  onRegister: (formatId: string) => void;
  onUnregister: (tournamentId: string) => void;
  onCreate: (p: SngCreatePayload) => void;
  onJoin: (tournamentId: string) => void;
  /** le créateur lance le tournoi avec les inscrits présents */
  onStart: (tournamentId: string) => void;
  /** tournoi reçu par lien d'invitation, pas encore rejoint */
  invite: SngSnapshot | null;
}

/** Lien d'invitation d'un tournoi (page de jeu avec ?t=<id>). */
export function inviteLink(tournamentId: string): string {
  return typeof window === "undefined" ? `/play?t=${tournamentId}` : `${window.location.origin}/play?t=${tournamentId}`;
}

const isCustom = (t: SngSnapshot) => t.formatId.startsWith("custom:");
const titleOf = (t: SngSnapshot) => t.name ?? (t.createdBy ? `Tournoi de ${t.createdBy}` : `Sit & Go ${t.size} joueurs`);

/**
 * Panneau Sit & Go en direct : cagnotte, retenue du rake, structure des gains, classement live
 * et appariements. Toutes les valeurs viennent de `sng:update` (serveur) : rien n'est simulé.
 */
export const TournamentHUD = memo(function TournamentHUD(p: Props) {
  if (!p.current) return <Lobby {...p} />;
  const t = p.current;
  const prize = prizeBreakdown(t);
  const rows = liveStandings(t);
  const pairings = currentPairings(t);
  const registered = t.players.filter((x) => x.status !== "unregistered" && x.status !== "refunded").length;
  const me = t.players.find((x) => x.userId === p.userId);
  const waiting = waitingInfo(t, p.userId);

  return (
    <section className="flex flex-col gap-3" aria-label="Tournoi en cours">
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-neon">{isCustom(t) ? titleOf(t) : "Sit & Go"} · {fieldSize(t)} joueurs</p>
          <h2 className="font-display text-lg font-bold">{TC_LABEL[t.timeControl]} · entrée {formatMoney(t.buyInCents, t.currency)}</h2>
        </div>
        <StatusChip t={t} registered={registered} />
      </header>

      {waiting && (
        <p role="status" className="rounded-lg border border-win/40 bg-win/10 px-3 py-2 text-sm text-win">
          {waiting === "bye" ? "Tu es exempt à ce tour : qualifié d'office pour le suivant." : "Qualifié ✓"} Ta prochaine partie démarre dès que tous les matchs du tour sont terminés.
        </p>
      )}

      {/* Cagnotte (ou tournoi gratuit) */}
      {prize.grossCents === 0 && prize.sponsorCents === 0 ? (
        <div className="panel relative overflow-hidden p-4">
          <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-neon/10 blur-2xl" />
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Tournoi gratuit</p>
          <p className="font-display text-2xl font-bold text-gold">🏆 Pour le titre</p>
          <p className="mt-1 text-sm text-muted">Élimination directe · revanche puis Armageddon en cas de nulle · parties classées Elo.</p>
        </div>
      ) : (
      <div className="panel relative overflow-hidden p-4">
        <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-gold/10 blur-2xl" />
        <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Prizepool</p>
        <p className="tabular font-display text-3xl font-bold text-gold">{formatMoney(prize.poolCents, t.currency)}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Entrées</dt>
          <dd className="tabular text-right">{formatMoney(prize.grossCents, t.currency)}</dd>
          <dt className="text-muted">Rake {prize.rakePct.toLocaleString("fr-FR")} %{prize.rakeSettled ? " (prélevé)" : ""}</dt>
          <dd className="tabular text-right text-danger/90">− {formatMoney(prize.rakeCents, t.currency)}</dd>
          {prize.sponsorCents > 0 && (<>
            <dt className="text-muted">Dotation</dt>
            <dd className="tabular text-right text-win">+ {formatMoney(prize.sponsorCents, t.currency)}</dd>
          </>)}
        </dl>
        <div className="mt-3 flex gap-2">
          {prize.payouts.map((x) => (
            <div key={x.rank} className="flex-1 rounded-lg bg-surface-2 px-2 py-1.5 text-center">
              <p className="text-[11px] text-muted">{x.rank === 1 ? "1er" : `${x.rank}e`} · {x.pct.toLocaleString("fr-FR")} %</p>
              <p className="tabular text-sm font-semibold">{formatMoney(x.cents, t.currency)}</p>
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Classement live */}
      <div className="panel p-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Classement live</h3>
        <ol className="flex flex-col gap-0.5">
          {rows.map((r) => <StandingLine key={r.userId} r={r} me={r.userId === p.userId} currency={t.currency} rounds={t.rounds.length} />)}
          {t.status === "registering" && t.size - rows.length > 0 && (t.size - rows.length <= 6
            ? Array.from({ length: t.size - rows.length }, (_, i) => (
                <li key={`empty${i}`} className="rounded-md px-2 py-1.5 text-sm text-muted/50">place libre</li>
              ))
            : <li className="rounded-md px-2 py-1.5 text-sm text-muted/60">+ {t.size - rows.length} places libres</li>)}
        </ol>
      </div>

      {/* Appariements */}
      {pairings && (
        <div className="panel p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{pairings.label}</h3>
          <ul className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
            {pairings.matches.map((m) => {
              const mine = m.p1 === p.userId || m.p2 === p.userId;
              const last = m.games[m.games.length - 1];
              return (
                <li key={m.slot} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${mine ? "bg-neon/10 ring-1 ring-neon/40" : "bg-surface-2"}`}>
                  <Seat name={m.p1} winner={m.winner} />
                  <span className="text-xs text-muted">vs</span>
                  <Seat name={m.p2} winner={m.winner} bye={m.round === 1 && m.p1 !== null && m.p2 === null} />
                  <span className="ml-auto shrink-0 text-xs">
                    {m.status === "playing" ? <span className="text-neon">● en jeu{last && last.kind !== "main" ? ` (${last.kind === "rematch" ? "revanche" : "armageddon"})` : ""}</span>
                      : m.status === "done" ? <span className="text-muted">{last?.result ?? (m.p2 === null ? "qualifié" : "—")}</span>
                      : <span className="text-muted">à venir</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {t.status === "registering" && <InviteBox t={t} />}
      {t.status === "registering" && t.createdBy === p.userId && (
        <StartNow t={t} busy={p.busy === `start:${t.id}`} onStart={() => p.onStart(t.id)} />
      )}
      {t.status === "registering" && me && (
        <button type="button" disabled={p.busy === t.id} onClick={() => p.onUnregister(t.id)}
          className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">
          Se désinscrire (remboursement intégral)
        </button>
      )}
      {t.status === "cancelled" && <p className="text-sm text-gold">Tournoi annulé{t.cancelReason ? ` : ${t.cancelReason}` : ""}. Entrées remboursées.</p>}
      {p.error && <p role="alert" className="text-sm text-danger">{SNG_ERRORS[p.error] ?? "Action refusée."}</p>}
    </section>
  );
});

function StatusChip({ t, registered }: { t: SngSnapshot; registered: number }) {
  const label = t.status === "registering" ? `Inscriptions ${registered}/${t.size}`
    : t.status === "running" ? "En cours" : t.status === "finished" ? "Terminé" : "Annulé";
  const tone = t.status === "running" ? "border-neon/50 text-neon" : t.status === "finished" ? "border-gold/50 text-gold" : "border-line text-muted";
  return <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>;
}

function Seat({ name, winner, bye }: { name: string | null; winner: string | null; bye?: boolean }) {
  if (bye) return <span className="text-muted">exempt</span>;
  if (!name) return <span className="text-muted/60">à déterminer</span>;
  const won = winner === name;
  const lost = winner !== null && !won;
  return <span className={`max-w-[38%] truncate ${won ? "font-semibold text-win" : lost ? "text-muted line-through decoration-1" : ""}`}>{name}</span>;
}

function StandingLine({ r, me, currency, rounds }: { r: StandingRow; me: boolean; currency: SngSnapshot["currency"]; rounds: number }) {
  const state = r.state === "winner" ? <span className="text-gold">vainqueur</span>
    : r.state === "playing" ? <span className="text-neon">en jeu</span>
    : r.state === "eliminated" ? <span className="text-muted">éliminé · {rounds > 0 && r.eliminatedRound ? roundLabel(r.eliminatedRound - 1, rounds - 1).toLowerCase() : ""}</span>
    : r.state === "waiting" ? <span className="text-muted">inscrit</span>
    : <span className="text-win">en lice</span>;
  return (
    <li className={`grid grid-cols-[1.5rem_1fr_auto_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm ${me ? "bg-neon/10" : ""}`}>
      <span className="tabular text-muted">{r.rank}</span>
      <span className="truncate">{r.userId}<span className="tabular ml-1.5 text-xs text-muted">{r.rating}</span></span>
      <span className="text-xs">{state}</span>
      <span className="tabular min-w-[4.5rem] text-right text-xs">{r.payoutCents > 0 ? formatMoney(r.payoutCents, currency) : ""}</span>
    </li>
  );
}

function Lobby({ lobby, busy, error, onRegister, onJoin, onCreate, invite, userId }: Props) {
  const open = lobby.filter((t) => t.status === "registering" && t.id !== invite?.id);
  return (
    <section className="flex flex-col gap-3" aria-label="Tournois Sit & Go">
      {invite && <InviteCard t={invite} userId={userId} busy={busy} onJoin={onJoin} />}
      <CreateForm busy={busy === "create"} onCreate={onCreate} />
      <h2 className="mt-1 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Tournois ouverts</h2>
      {open.length === 0 && <p className="text-sm text-muted">Aucun tournoi en attente de joueurs.</p>}
      {open.map((t) => {
        const n = registeredCount(t);
        const key = isCustom(t) ? t.id : t.formatId;
        return (
          <div key={t.id} className={`panel flex items-center gap-3 p-3 ${isCustom(t) ? "border-neon/30" : ""}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{isCustom(t) ? titleOf(t) : `${TC_LABEL[t.timeControl]} · ${t.size} joueurs`}</p>
              <p className="text-xs text-muted">
                {isCustom(t) ? `${TC_LABEL[t.timeControl]} · ${t.size} joueurs · ` : ""}entrée {formatMoney(t.buyInCents, t.currency)} · cagnotte <span className="text-gold">{formatMoney(t.prizePoolCents, t.currency)}</span>
              </p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-neon" style={{ width: `${(n / t.size) * 100}%` }} />
              </div>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => (isCustom(t) ? onJoin(t.id) : onRegister(t.formatId))} className="neon-btn shrink-0 rounded-lg px-3 py-2 text-sm font-semibold">
              {busy === key ? "…" : `Rejoindre ${n}/${t.size}`}
            </button>
          </div>
        );
      })}
      {error && <p role="alert" className="text-sm text-danger">{SNG_ERRORS[error] ?? "Action refusée."}</p>}
    </section>
  );
}

const registeredCount = (t: SngSnapshot) => t.players.filter((x) => x.status !== "unregistered" && x.status !== "refunded").length;

const SIZES = [4, 8, 16, 32, 64];
const TCS: TimeControlId[] = ["bullet_1_0", "blitz_3_0", "blitz_3_2", "rapid_5_0"];
const ENTRIES = [0, 100, 500, 1000];

/** Création d'un tournoi à élimination directe, en jetons. */
function CreateForm({ busy, onCreate }: { busy: boolean; onCreate: (p: SngCreatePayload) => void }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(4);
  const [tc, setTc] = useState<TimeControlId>("blitz_3_0");
  const [entry, setEntry] = useState(0);
  const [name, setName] = useState("");
  const pick = "rounded-lg px-2 py-1.5 text-sm font-semibold transition";
  const on = "bg-ink text-neon ring-1 ring-neon/50";
  const off = "text-muted hover:text-text";
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="neon-btn rounded-xl px-4 py-3 text-left">
        <span className="block font-display text-lg font-bold">＋ Créer un tournoi</span>
        <span className="text-xs text-muted">Élimination directe · invite tes amis avec un lien</span>
      </button>
    );
  }
  const pool = Math.floor(entry * size * 0.9);
  return (
    <form className="panel flex flex-col gap-3 p-3" onSubmit={(e) => { e.preventDefault(); onCreate({ size, timeControl: tc, buyInCents: entry, name: name.trim() || undefined }); }}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-bold">Nouveau tournoi</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:text-text">Fermer</button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Nom (facultatif)
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Soirée échecs en famille"
          className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60" />
      </label>
      <div className="flex flex-col gap-1 text-xs text-muted">
        Joueurs
        <div className="flex items-center gap-1 rounded-xl bg-surface-2 p-1">
          <button type="button" aria-label="Un joueur de moins" onClick={() => setSize((s) => Math.max(SNG_MIN_SIZE, s - 1))} className={`${pick} ${off} w-9`}>−</button>
          <input type="number" inputMode="numeric" min={SNG_MIN_SIZE} max={SNG_MAX_SIZE} value={size} aria-label="Nombre de joueurs"
            onChange={(e) => setSize(Math.max(SNG_MIN_SIZE, Math.min(SNG_MAX_SIZE, Math.round(Number(e.target.value) || SNG_MIN_SIZE))))}
            className="tabular w-16 rounded-lg bg-ink py-1.5 text-center text-sm font-semibold text-neon outline-none ring-1 ring-neon/40" />
          <button type="button" aria-label="Un joueur de plus" onClick={() => setSize((s) => Math.min(SNG_MAX_SIZE, s + 1))} className={`${pick} ${off} w-9`}>+</button>
          <div className="ml-auto flex gap-0.5">
            {SIZES.map((n) => <button key={n} type="button" aria-pressed={size === n} onClick={() => setSize(n)} className={`${pick} px-1.5 ${size === n ? on : off}`}>{n}</button>)}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        Cadence
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
          {TCS.map((x) => <button key={x} type="button" aria-pressed={tc === x} onClick={() => setTc(x)} className={`${pick} ${tc === x ? on : off}`}>{TC_LABEL[x]}</button>)}
        </div>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        Entrée (jetons, sans valeur)
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface-2 p-1">
          {ENTRIES.map((x) => <button key={x} type="button" aria-pressed={entry === x} onClick={() => setEntry(x)} className={`tabular ${pick} ${entry === x ? on : off}`}>{x === 0 ? "Gratuit" : x / 100}</button>)}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {(() => { const b = bracketInfo(size); return `${size} joueurs : ${b.rounds} tour${b.rounds > 1 ? "s" : ""}${b.byes > 0 ? `, ${b.byes} exempt${b.byes > 1 ? "s" : ""} au 1er tour (les mieux classés)` : ""}. `; })()}
        En cas de nulle : revanche, puis Armageddon.{entry > 0 ? ` Cagnotte ≈ ${formatMoney(pool, "PLAY")} (65 % / 35 %).` : ""}
        {" "}Il démarre dès qu'il est complet, ou quand tu le lances.
      </p>
      <button type="submit" disabled={busy} className="neon-btn rounded-lg px-3 py-2.5 font-semibold">{busy ? "Création…" : "Créer et m'inscrire"}</button>
    </form>
  );
}

/** Lien à partager tant que le tournoi attend des joueurs. */
function InviteBox({ t }: { t: SngSnapshot }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(t.id);
  const missing = t.size - registeredCount(t);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "ChessArena", text: `Rejoins mon tournoi d'échecs « ${titleOf(t)} »`, url: link });
      else { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch { /* partage annulé */ }
  };
  return (
    <div className="panel flex flex-col gap-2 border-neon/30 p-3">
      <p className="text-sm">Encore <b className="text-neon">{missing}</b> joueur{missing > 1 ? "s" : ""} pour démarrer. Envoie ce lien :</p>
      <div className="flex gap-2">
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 py-1.5 font-mono text-xs text-muted" />
        <button type="button" onClick={() => void share()} className="neon-btn shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold">{copied ? "Copié ✓" : "Partager"}</button>
      </div>
      <p className="text-[11px] text-muted">Tes invités créent leur compte (30 secondes) s'ils n'en ont pas, puis rejoignent en un clic.</p>
    </div>
  );
}

/** Bouton du créateur : lancer sans attendre que le tournoi soit complet (confirmation en deux temps). */
function StartNow({ t, busy, onStart }: { t: SngSnapshot; busy: boolean; onStart: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const n = t.players.filter((x) => x.status === "registered").length;
  if (n < 2) return <p className="text-xs text-muted">Tu pourras lancer le tournoi dès qu'il y aura au moins 2 inscrits.</p>;
  if (n === t.size) return null; // complet : il démarre tout seul
  const b = bracketInfo(n);
  return confirm ? (
    <div className="panel flex flex-col gap-2 border-gold/40 p-3">
      <p className="text-sm">Lancer maintenant avec <b>{n} joueurs</b> ? {b.rounds} tour{b.rounds > 1 ? "s" : ""}{b.byes > 0 ? `, ${b.byes} exempt${b.byes > 1 ? "s" : ""} au 1er tour` : ""}. Plus personne ne pourra s'inscrire.</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onStart} className="neon-btn flex-1 rounded-lg px-3 py-2 text-sm font-semibold">{busy ? "Lancement…" : "Oui, lancer"}</button>
        <button type="button" onClick={() => setConfirm(false)} className="flex-1 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-text">Attendre</button>
      </div>
    </div>
  ) : (
    <button type="button" onClick={() => setConfirm(true)} className="rounded-lg border border-gold/50 px-3 py-2 text-sm font-semibold text-gold hover:bg-gold/10">
      ▶ Lancer maintenant avec {n} joueurs
    </button>
  );
}

/** Carte affichée en arrivant par un lien d'invitation. */
function InviteCard({ t, userId, busy, onJoin }: { t: SngSnapshot; userId: string; busy: string | null; onJoin: (id: string) => void }) {
  const n = registeredCount(t);
  const already = t.players.some((p) => p.userId === userId && p.status !== "unregistered" && p.status !== "refunded");
  return (
    <div className="panel relative overflow-hidden border-neon/50 p-4">
      <div className="pointer-events-none absolute -right-10 -top-10 size-36 rounded-full bg-neon/15 blur-2xl" />
      <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-neon">Invitation</p>
      <h3 className="font-display text-lg font-bold">{titleOf(t)}</h3>
      <p className="text-sm text-muted">
        {TC_LABEL[t.timeControl]} · {t.size} joueurs · entrée {formatMoney(t.buyInCents, t.currency)}{t.createdBy ? ` · créé par ${t.createdBy}` : ""}
      </p>
      <p className="mt-1 text-sm">{n}/{t.size} inscrits</p>
      {t.status === "registering" && !already && (
        <button type="button" disabled={busy !== null} onClick={() => onJoin(t.id)} className="neon-btn mt-3 w-full rounded-lg px-3 py-2.5 font-semibold">
          {busy === t.id ? "Inscription…" : "Rejoindre le tournoi"}
        </button>
      )}
      {t.status !== "registering" && <p className="mt-2 text-sm text-gold">Ce tournoi a déjà {t.status === "running" ? "commencé" : "pris fin"}.</p>}
    </div>
  );
}
