"use client";
import { memo, useEffect, useState } from "react";
import { SITE_NAME } from "../lib/site";
import { ARENA_MINUTES, SNG_MAX_SIZE, SNG_MIN_SIZE, type ClubSummary, type SngCreatePayload, type SngSnapshot, type TimeControlId } from "@chessarena/shared";
import { weeklyLabel, ARENA_RULES, arenaJoinable, arenaRows, isArena, remaining, defaultStart, startsIn, startsLabel, KNOCKOUT_RULES, SWISS_RULES, fmtPoints, isSwiss, swissBoardScore, swissRows, swissRoundsFor, matchDetail, bracketInfo, currentPairings, fieldSize, formatMoney, liveStandings, prizeBreakdown, roundLabel, waitingInfo, type StandingRow } from "../lib/tournament";

const TC_LABEL: Record<TimeControlId, string> = {
  bullet_1_0: "Bullet 1+0", blitz_3_0: "Blitz 3+0", blitz_3_2: "Blitz 3+2", rapid_5_0: "Rapide 5+0",
};

/** Codes renvoyés par sng:register / sng:unregister (game-server). */
export const SNG_ERRORS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Solde insuffisant pour cette entrée.",
  ALREADY_REGISTERED: "Vous êtes déjà inscrit à cette table.",
  IN_GAME: "Terminez votre partie en cours.",
  NOT_CLUB_MEMBER: "Réservé aux membres du club (bataille de clubs : membres des clubs engagés).",
  UNKNOWN_CLUB: "Un des clubs indiqués n'existe pas (vérifie son adresse, par exemple « les-fous-du-roi »).",
  IN_TOURNAMENT: "Tu es déjà inscrit à un tournoi (un seul à la fois, même programmé).",
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
  NOT_ENOUGH_PLAYERS: "Il faut au moins 3 inscrits pour lancer le tournoi.",
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
  /** lien vers la page du tournoi (absent sur la page du tournoi elle-même) */
  pageLink?: boolean;
  /** arena : pause / reprise */
  onPause?: (tournamentId: string, paused: boolean) => void;
}

/** Lien d'invitation d'un tournoi : sa page publique (aperçu riche quand on le partage), d'où l'on s'inscrit en un clic. */
export function inviteLink(tournamentId: string): string {
  return typeof window === "undefined" ? `/tournoi/${tournamentId}` : `${window.location.origin}/tournoi/${tournamentId}`;
}

const isCustom = (t: SngSnapshot) => t.formatId.startsWith("custom:");
/** « Suisse · 5 rondes » ou « Élimination directe » */
const formatOf = (t: SngSnapshot) => t.teamBattle ? `Bataille de clubs · ${t.arenaMinutes} min` : isArena(t) ? `Arena · ${t.arenaMinutes} min` : isSwiss(t) ? `Suisse · ${t.totalRounds ?? swissRoundsFor(t.size)} rondes` : "Élimination directe";
const titleOf = (t: SngSnapshot) => t.name ?? (t.teamBattle ? [...t.teamBattle.teams].sort((a, b) => a.name.localeCompare(b.name)).map((x) => x.name).join(" vs ") : t.club ? `Tournoi · ${t.club.name}` : t.createdBy ? `Tournoi de ${t.createdBy}` : `Sit & Go ${t.size} joueurs`);

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
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-neon">{isCustom(t) ? titleOf(t) : "Sit & Go"} · {fieldSize(t)} joueurs{isSwiss(t) || isArena(t) ? ` · ${formatOf(t)}` : ""}</p>
          <h2 className="font-display text-lg font-bold">{TC_LABEL[t.timeControl]} · entrée {formatMoney(t.buyInCents, t.currency)}</h2>
        </div>
        <StatusChip t={t} registered={registered} />
      </header>
      {t.club && <a href={`/club/${t.club.slug}`} className="-mt-2 text-xs text-gold hover:underline">Club : {t.club.name} →</a>}
      {p.pageLink !== false && t.status !== "cancelled" && (
        <a href={`/tournoi/${t.id}`} className="-mt-1 text-xs text-neon hover:underline">Page du tournoi : classement en direct, à partager à ton club →</a>
      )}

      {t.status === "registering" && t.startsAt && <StartsBanner iso={t.startsAt} weekly={!!t.repeatWeekly} />}

      {isArena(t) && t.status === "running" && me?.status === "playing" && <ArenaMe t={t} userId={p.userId} busy={p.busy === `pause:${t.id}`} onPause={(x) => p.onPause?.(t.id, x)} />}

      {waiting && !isArena(t) && (
        <p role="status" className="rounded-lg border border-win/40 bg-win/10 px-3 py-2 text-sm text-win">
          {isSwiss(t)
            ? (waiting === "bye" ? "Tu es exempt à cette ronde : 1 point d'office." : "Partie terminée ✓") + (t.currentRound < (t.totalRounds ?? 0) ? (t.nextRoundAt ? " La ronde suivante démarre dans quelques secondes." : " La ronde suivante démarre dès que toutes les parties sont finies.") : " Classement final dès que la dernière partie est finie.")
            : <>{waiting === "bye" ? "Tu es exempt à ce tour : qualifié d'office pour le suivant." : "Qualifié ✓"} Ta prochaine partie démarre dès que tous les matchs du tour sont terminés.</>}
        </p>
      )}

      {/* Cagnotte (ou tournoi gratuit) */}
      {prize.grossCents === 0 && prize.sponsorCents === 0 ? (
        <div className="panel relative overflow-hidden p-4">
          <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-neon/10 blur-2xl" />
          <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Tournoi gratuit</p>
          <p className="font-display text-2xl font-bold text-gold">🏆 Pour le titre</p>
          <p className="mt-1 text-sm text-muted">{isArena(t) ? `Arena de ${t.arenaMinutes} minutes · parties enchaînées, séries 🔥 · parties classées Elo.` : isSwiss(t) ? `Système suisse en ${t.totalRounds ?? swissRoundsFor(t.size)} rondes · tout le monde joue chaque ronde · parties classées Elo.` : "Élimination directe · revanche puis Armageddon en cas de nulle · parties classées Elo."}</p>
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

      <details className="panel p-3 text-xs text-muted">
        <summary className="cursor-pointer font-semibold text-text">Comment se joue le tournoi ?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">{(isArena(t) ? ARENA_RULES : isSwiss(t) ? SWISS_RULES : KNOCKOUT_RULES).map((r) => <li key={r}>{r}</li>)}</ul>
      </details>

      {/* Classement live */}
      {t.teamBattle && <TeamBattle t={t} userId={p.userId} />}
      {isArena(t) && t.status !== "registering" ? <ArenaTable t={t} userId={p.userId} /> : isSwiss(t) && t.status !== "registering" ? <SwissTable t={t} userId={p.userId} /> : (
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
      )}

      {/* Appariements */}
      {/* tour en cours puis tours précédents : on garde la trace de chaque match (nulles, revanches, Armageddon) */}
      {isArena(t) && t.rounds[0]?.length ? <ArenaGames t={t} userId={p.userId} /> : null}
      {pairings && isSwiss(t) && <SwissRounds t={t} userId={p.userId} />}
      {pairings && !isSwiss(t) && !isArena(t) && Array.from({ length: pairings.round + 1 }, (_, i) => pairings.round - i).map((r) => (
        <div key={r} className="panel p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{roundLabel(r, t.rounds.length - 1)}</h3>
          <ul className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
            {(t.rounds[r] ?? []).map((m) => {
              const mine = m.p1 === p.userId || m.p2 === p.userId;
              const last = m.games[m.games.length - 1];
              const d0 = matchDetail(m);
              // plusieurs parties ou explication : sur une ligne à part, pour ne pas écraser les pseudos
              const detail = { ...d0, long: !!d0.why || d0.score.length > 8 };
              return (
                <li key={m.slot} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-sm ${mine ? "bg-neon/10 ring-1 ring-neon/40" : "bg-surface-2"}`}>
                  <Seat name={m.p1} winner={m.winner} />
                  <span className="text-xs text-muted">vs</span>
                  <Seat name={m.p2} winner={m.winner} bye={m.round === 1 && m.p1 !== null && m.p2 === null} />
                  <span className="ml-auto shrink-0 text-xs">
                    {m.status === "playing" ? <span className="text-neon">● en jeu{last && last.kind !== "main" ? ` (${last.kind === "rematch" ? "revanche" : "armageddon"})` : ""}
                      {!mine && last && !last.result && <a href={`/direct/${last.gameId}`} target="_blank" rel="noreferrer" className="ml-1.5 rounded bg-neon/15 px-1.5 py-0.5 font-semibold hover:bg-neon/25" title="Regarder la partie">👁 Regarder</a>}</span>
                      : m.status === "done" ? (detail.long ? null : <span className="text-muted">{detail.score}</span>)
                      : <span className="text-muted">à venir</span>}
                  </span>
                  {m.status === "done" && detail.long && (
                    <span className="w-full pl-1 text-xs text-muted">{detail.score}{detail.why && <span className="block text-[11px] text-muted/80">{detail.why}</span>}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {t.status === "registering" && registeredCount(t) < t.size && <InviteBox t={t} />}
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
    : t.status === "running" ? (isArena(t) && t.arenaEndsAt ? <ArenaClock iso={t.arenaEndsAt} /> : isSwiss(t) ? `Ronde ${t.currentRound}/${t.totalRounds}` : "En cours") : t.status === "finished" ? "Terminé" : "Annulé";
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
                {t.startsAt && <span className="block font-semibold text-gold">Départ {startsLabel(t.startsAt)}{t.repeatWeekly ? " · 🔁 chaque semaine" : ""}</span>}
                {isCustom(t) ? `${TC_LABEL[t.timeControl]} · ${t.size} joueurs · ${formatOf(t)} · ` : ""}entrée {formatMoney(t.buyInCents, t.currency)} · cagnotte <span className="text-gold">{formatMoney(t.prizePoolCents, t.currency)}</span>
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
  const [system, setSystem] = useState<"swiss" | "arena" | "ko">("swiss");
  const [minutes, setMinutes] = useState(45);
  const [rounds, setRounds] = useState(0);
  const [when, setWhen] = useState<"full" | "time">("full");
  const [startAt, setStartAt] = useState(defaultStart);
  const [weekly, setWeekly] = useState(false);
  // clubs dont je suis membre : tournoi du club (présélectionné depuis la page du club : ?club=…)
  const [myClubs, setMyClubs] = useState<ClubSummary[]>([]);
  const [club, setClub] = useState("");
  // bataille de clubs (arena) : clubs engagés (les miens cochés + adresses d'autres clubs) et joueurs qui comptent
  const [battle, setBattle] = useState(false);
  const [teams, setTeams] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [leaders, setLeaders] = useState(5);
  const toggleTeam = (slug: string) => setTeams((x) => (x.includes(slug) ? x.filter((y) => y !== slug) : [...x, slug].slice(0, 8)));
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("club") ?? "";
    fetch("/api/clubs", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) return; const d = (await r.json()) as { mine: ClubSummary[] }; setMyClubs(d.mine); if (d.mine.some((c) => c.slug === wanted)) setClub(wanted); })
      .catch(() => {});
  }, []);
  const pick = "rounded-lg px-2 py-1.5 text-sm font-semibold transition";
  const on = "bg-ink text-neon ring-1 ring-neon/50";
  const off = "text-muted hover:text-text";
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="neon-btn rounded-xl px-4 py-3 text-left">
        <span className="block font-display text-lg font-bold">＋ Créer un tournoi</span>
        <span className="text-xs text-muted">Système suisse ou élimination directe · invite tes amis ou ton club avec un lien</span>
      </button>
    );
  }
  const pool = Math.floor(entry * size * 0.9);
  return (
    <form className="panel flex flex-col gap-3 p-3" onSubmit={(e) => { e.preventDefault(); onCreate({ size, timeControl: tc, buyInCents: entry, name: name.trim() || undefined, system, ...(system === "swiss" && rounds ? { rounds } : {}), ...(system === "arena" ? { arenaMinutes: minutes } : {}), ...(when === "time" ? { startsAt: new Date(startAt).toISOString(), ...(weekly ? { repeatWeekly: true } : {}) } : {}), ...(club && !(system === "arena" && battle) ? { clubSlug: club } : {}), ...(system === "arena" && battle ? { teamClubs: teams, teamLeaders: leaders } : {}) }); }}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-bold">Nouveau tournoi</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted hover:text-text">Fermer</button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Nom (facultatif)
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Soirée échecs en famille"
          className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60" />
      </label>
      {myClubs.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-muted">
          Club
          <select value={club} onChange={(e) => setClub(e.target.value)} aria-label="Club du tournoi"
            className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60">
            <option value="">Aucun (tournoi personnel)</option>
            {myClubs.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div className="flex flex-col gap-1 text-xs text-muted">
        Format
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
          <button type="button" aria-pressed={system === "swiss"} onClick={() => setSystem("swiss")} className={`${pick} ${system === "swiss" ? on : off}`}>Suisse</button>
          <button type="button" aria-pressed={system === "arena"} onClick={() => setSystem("arena")} className={`${pick} ${system === "arena" ? on : off}`}>Arena</button>
          <button type="button" aria-pressed={system === "ko"} onClick={() => setSystem("ko")} className={`${pick} px-1 ${system === "ko" ? on : off}`}>Élimination</button>
        </div>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        Joueurs (au plus)
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
      {system === "arena" && (
        <div className="flex flex-col gap-2 rounded-xl border border-gold/30 p-2 text-xs text-muted">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={battle} onChange={(e) => setBattle(e.target.checked)} className="size-4" aria-label="Bataille de clubs" />
            ⚔️ Bataille de clubs <span className="text-xs text-muted">(club contre club)</span>
          </label>
          {battle && (
            <>
              <p>Chaque joueur défend son club, jamais contre un coéquipier ; le score d'un club = les points de ses {leaders} meilleurs joueurs.</p>
              <div className="flex flex-wrap gap-1.5">
                {myClubs.map((c) => (
                  <button key={c.slug} type="button" aria-pressed={teams.includes(c.slug)} onClick={() => toggleTeam(c.slug)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${teams.includes(c.slug) ? "border-gold bg-gold/15 text-gold" : "border-line text-muted"}`}>{c.name}</button>
                ))}
                {teams.filter((t) => !myClubs.some((c) => c.slug === t)).map((t) => (
                  <button key={t} type="button" onClick={() => toggleTeam(t)} className="rounded-full border border-gold bg-gold/15 px-2.5 py-1 text-xs text-gold">{t} ✕</button>
                ))}
              </div>
              <div className="flex gap-1.5">
                <input value={other} onChange={(e) => setOther(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="adresse d'un autre club (ex. echiquier-marseillais)" aria-label="Adresse d'un autre club"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-text outline-none focus:border-neon/60" />
                <button type="button" disabled={other.length < 2} onClick={() => { toggleTeam(other); setOther(""); }} className="rounded-lg border border-line px-2.5 text-xs text-text">Ajouter</button>
              </div>
              <div className="flex items-center gap-2">
                Joueurs qui comptent par club
                {[3, 5, 10].map((n) => <button key={n} type="button" aria-pressed={leaders === n} onClick={() => setLeaders(n)} className={`rounded-md px-2 py-0.5 font-semibold ${leaders === n ? "bg-gold/20 text-gold" : "text-muted"}`}>{n}</button>)}
              </div>
              {teams.length < 2 && <p className="text-gold">Choisis au moins 2 clubs (le tien et le club adverse).</p>}
            </>
          )}
        </div>
      )}
      {system === "arena" && (
        <div className="flex flex-col gap-1 text-xs text-muted">
          Durée
          <div className="grid grid-cols-6 gap-1 rounded-xl bg-surface-2 p-1">
            {ARENA_MINUTES.map((x) => <button key={x} type="button" aria-pressed={minutes === x} onClick={() => setMinutes(x)} className={`tabular ${pick} px-1 ${minutes === x ? on : off}`}>{x < 60 ? `${x}′` : `${x / 60} h`}</button>)}
          </div>
        </div>
      )}
      {system === "swiss" && (
        <div className="flex flex-col gap-1 text-xs text-muted">
          Rondes
          <div className="grid grid-cols-6 gap-1 rounded-xl bg-surface-2 p-1">
            {[0, 3, 4, 5, 6, 7].map((x) => <button key={x} type="button" aria-pressed={rounds === x} onClick={() => setRounds(x)} className={`tabular ${pick} px-1 ${rounds === x ? on : off}`}>{x === 0 ? "Auto" : x}</button>)}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1 text-xs text-muted">
        Cadence
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
          {TCS.map((x) => <button key={x} type="button" aria-pressed={tc === x} onClick={() => setTc(x)} className={`${pick} ${tc === x ? on : off}`}>{TC_LABEL[x]}</button>)}
        </div>
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        Départ
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
          <button type="button" aria-pressed={when === "full"} onClick={() => setWhen("full")} className={`${pick} ${when === "full" ? on : off}`}>Dès que complet</button>
          <button type="button" aria-pressed={when === "time"} onClick={() => setWhen("time")} className={`${pick} ${when === "time" ? on : off}`}>À une heure précise</button>
        </div>
        {when === "time" && (
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} aria-label="Date et heure du départ" required
            className="mt-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-neon/60 [color-scheme:dark]" />
        )}
        {when === "time" && (
          <label className="mt-1 flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} className="size-4 accent-[var(--neon,#22d3ee)]" />
            Répéter chaque semaine{startAt ? ` (${weeklyLabel(new Date(startAt).toISOString())})` : ""}
          </label>
        )}
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted">
        Entrée (jetons, sans valeur)
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-surface-2 p-1">
          {ENTRIES.map((x) => <button key={x} type="button" aria-pressed={entry === x} onClick={() => setEntry(x)} className={`tabular ${pick} ${entry === x ? on : off}`}>{x === 0 ? "Gratuit" : x / 100}</button>)}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {system === "arena"
          ? `Jusqu'à ${size} joueurs pendant ${minutes} minutes : un nouvel adversaire dès que ta partie est finie, victoire 2 points, série 🔥 après deux victoires (victoires à 4). On peut arriver en cours de route.${entry > 0 ? ` Cagnotte ≈ ${formatMoney(pool, "PLAY")}.` : ""}`
          : system === "swiss"
          ? `${size} joueurs : ${swissRoundsFor(size, rounds)} rondes, tout le monde joue chaque ronde (victoire 1, nulle ½). Les rondes s'adaptent au nombre d'inscrits.${entry > 0 ? ` Cagnotte ≈ ${formatMoney(pool, "PLAY")} (${size >= 8 ? "50 % / 30 % / 20 %" : "65 % / 35 %"}).` : ""}`
          : <>{(() => { const b = bracketInfo(size); return `${size} joueurs : ${b.rounds} tour${b.rounds > 1 ? "s" : ""}${b.byes > 0 ? `, ${b.byes} exempt${b.byes > 1 ? "s" : ""} au 1er tour (les mieux classés)` : ""}. `; })()}
        En cas de nulle : revanche, puis Armageddon.{entry > 0 ? ` Cagnotte ≈ ${formatMoney(pool, "PLAY")} (65 % / 35 %).` : ""}</>}
        {" "}{system === "arena" && when !== "time" ? "Elle démarre quand tu la lances (au moins 3 inscrits)." : when === "time" && startAt ? `Départ automatique ${startsLabel(new Date(startAt).toISOString())} (au moins 3 inscrits) ; les inscrits restent libres de jouer d'autres parties jusqu'à 5 min avant.` : "Il démarre dès qu'il est complet, ou quand tu le lances."}
      </p>
      <button type="submit" disabled={busy || (system === "arena" && battle && teams.length < 2)} className="neon-btn rounded-lg px-3 py-2.5 font-semibold">{busy ? "Création…" : "Créer et m'inscrire"}</button>
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
      if (navigator.share) await navigator.share({ title: SITE_NAME, text: `Rejoins mon tournoi d'échecs « ${titleOf(t)} »`, url: link });
      else { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch { /* partage annulé */ }
  };
  return (
    <div className="panel flex flex-col gap-2 border-neon/30 p-3">
      <p className="text-sm">{t.startsAt ? <>Jusqu'à <b className="text-neon">{missing}</b> place{missing > 1 ? "s" : ""} libre{missing > 1 ? "s" : ""}. Invite ton club avec ce lien :</> : <>Encore <b className="text-neon">{missing}</b> joueur{missing > 1 ? "s" : ""} pour démarrer. Envoie ce lien :</>}</p>
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
  if (n < SNG_MIN_SIZE) return <p className="text-xs text-muted">Tu pourras lancer le tournoi dès qu'il y aura au moins {SNG_MIN_SIZE} inscrits.</p>;
  if (n === t.size && !t.startsAt && !isArena(t)) return null; // complet : il démarre tout seul
  const b = bracketInfo(n);
  const plan = isArena(t) ? `${t.arenaMinutes} minutes de parties enchaînées (on pourra encore arriver en cours de route)` : isSwiss(t)
    ? `${swissRoundsFor(n, t.totalRounds && t.totalRounds !== swissRoundsFor(t.size) ? t.totalRounds : 0)} rondes, tout le monde joue chaque ronde`
    : `${b.rounds} tour${b.rounds > 1 ? "s" : ""}${b.byes > 0 ? `, ${b.byes} exempt${b.byes > 1 ? "s" : ""} au 1er tour` : ""}`;
  return confirm ? (
    <div className="panel flex flex-col gap-2 border-gold/40 p-3">
      <p className="text-sm">Lancer maintenant avec <b>{n} joueurs</b> ? {plan}. {isArena(t) ? "" : "Plus personne ne pourra s'inscrire."}</p>
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
        {TC_LABEL[t.timeControl]} · {t.size} joueurs · {formatOf(t)} · entrée {formatMoney(t.buyInCents, t.currency)}{t.createdBy ? ` · créé par ${t.createdBy}` : ""}
      </p>
      {t.startsAt && t.status === "registering" && <p className="mt-1 text-sm font-semibold text-gold">Départ {startsLabel(t.startsAt)} ({startsIn(t.startsAt)})</p>}
      <p className="mt-1 text-sm">{n}/{t.size} inscrits</p>
      {(t.status === "registering" || arenaJoinable(t)) && !already && (
        <button type="button" disabled={busy !== null} onClick={() => onJoin(t.id)} className="neon-btn mt-3 w-full rounded-lg px-3 py-2.5 font-semibold">
          {busy === t.id ? "Inscription…" : arenaJoinable(t) ? "Rejoindre l'arena en cours" : "Rejoindre le tournoi"}
        </button>
      )}
      {t.status !== "registering" && !arenaJoinable(t) && <p className="mt-2 text-sm text-gold">Ce tournoi a déjà {t.status === "running" ? "commencé" : "pris fin"}.</p>}
    </div>
  );
}

/** Classement d'un suisse : points et départages. */
function SwissTable({ t, userId }: { t: SngSnapshot; userId: string }) {
  const rows = swissRows(t);
  return (
    <div className="panel p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{t.status === "finished" ? "Classement final" : "Classement"}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-muted">
            <th className="w-7 font-normal">#</th><th className="font-normal">Joueur</th>
            <th className="w-10 text-right font-normal">Pts</th>
            <th className="w-12 text-right font-normal" title="Buchholz : points des adversaires rencontrés">Bu</th>
            {rows.some((r) => r.payoutCents > 0) && <th className="w-20 text-right font-normal">Gain</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className={r.userId === userId ? "bg-neon/10" : ""}>
              <td className="tabular py-1 pl-1 text-muted">{r.rank === 1 && t.status === "finished" ? "🏆" : r.rank}</td>
              <td className="max-w-0 truncate py-1">{r.userId}<span className="tabular ml-1.5 text-xs text-muted">{r.rating}</span>{r.playing && <span className="ml-1.5 text-xs text-neon">●</span>}</td>
              <td className="tabular py-1 text-right font-semibold">{fmtPoints(r.points)}</td>
              <td className="tabular py-1 text-right text-xs text-muted">{fmtPoints(r.buchholz)}</td>
              {rows.some((x) => x.payoutCents > 0) && <td className="tabular py-1 pr-1 text-right text-xs text-gold">{r.payoutCents > 0 ? formatMoney(r.payoutCents, t.currency) : ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Appariements d'un suisse : ronde en cours, puis rondes précédentes (repliées). */
function SwissRounds({ t, userId }: { t: SngSnapshot; userId: string }) {
  const n = t.rounds.length;
  return (
    <>
      {t.rounds.map((_, i) => n - 1 - i).map((r) => {
        const boards = t.rounds[r] ?? [];
        const body = (
          <ul className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
            {boards.map((m) => {
              const mine = m.p1 === userId || m.p2 === userId;
              const last = m.games.at(-1);
              return (
                <li key={m.slot} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${mine ? "bg-neon/10 ring-1 ring-neon/40" : "bg-surface-2"}`}>
                  {m.p2 === null ? (
                    <><span className="truncate">{m.p1}</span><span className="ml-auto shrink-0 text-xs text-muted">exempt (1 pt)</span></>
                  ) : (
                    <>
                      <span className="tabular w-5 shrink-0 text-xs text-muted">{m.slot + 1}</span>
                      <span className="size-2.5 shrink-0 rounded-sm border border-line bg-[#f3f3f3]" aria-hidden />
                      <span className={`min-w-0 max-w-[36%] truncate ${m.result === "1-0" ? "font-semibold text-win" : ""}`}>{m.p1}</span>
                      <span className="text-xs text-muted">–</span>
                      <span className="size-2.5 shrink-0 rounded-sm border border-line bg-[#222]" aria-hidden />
                      <span className={`min-w-0 max-w-[36%] truncate ${m.result === "0-1" ? "font-semibold text-win" : ""}`}>{m.p2}</span>
                      <span className="ml-auto shrink-0 text-xs">
                        {m.status === "playing"
                          ? <span className="text-neon">● en jeu{!mine && last && !last.result && <a href={`/direct/${last.gameId}`} target="_blank" rel="noreferrer" className="ml-1.5 rounded bg-neon/15 px-1.5 py-0.5 font-semibold hover:bg-neon/25" title="Regarder la partie">👁</a>}</span>
                          : m.status === "done"
                            ? (last ? <a href={`/partie/${last.gameId}`} className="tabular text-muted hover:text-text">{swissBoardScore(m)}</a> : <span className="tabular text-muted">{swissBoardScore(m)}</span>)
                            : <span className="text-muted">à venir</span>}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        );
        const title = `Ronde ${r + 1}/${t.totalRounds ?? n}`;
        return r === n - 1 ? (
          <div key={r} className="panel p-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{title}</h3>
            {body}
          </div>
        ) : (
          <details key={r} className="panel p-3">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{title}</summary>
            <div className="mt-2">{body}</div>
          </details>
        );
      })}
    </>
  );
}

/** Tournoi programmé : heure de départ et compte à rebours (rafraîchi chaque seconde dans la dernière heure). */
function StartsBanner({ iso, weekly }: { iso: string; weekly: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const soon = Date.parse(iso) - now < 60 * 60_000;
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), soon ? 1_000 : 30_000);
    return () => clearInterval(id);
  }, [soon]);
  return (
    <div className="panel border-gold/40 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-gold">Tournoi programmé{weekly ? ` · 🔁 ${weeklyLabel(iso)}` : ""}</p>
      <p className="font-display text-lg font-bold">Départ {startsLabel(iso)}</p>
      <p className="tabular text-sm text-muted">{startsIn(iso, now)} · départ automatique avec au moins 3 inscrits. Sois sur la page Jouer à l'heure : ta première partie démarre toute seule.</p>
    </div>
  );
}

/** Arena : temps restant (rafraîchi chaque seconde). */
function ArenaClock({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(id); }, []);
  return <span className="tabular">⏱ {remaining(iso, now)}</span>;
}

/** Arena : mon état (en partie, en attente d'un adversaire, en pause) et le bouton pause. */
function ArenaMe({ t, userId, busy, onPause }: { t: SngSnapshot; userId: string; busy: boolean; onPause: (paused: boolean) => void }) {
  const me = t.players.find((x) => x.userId === userId)!;
  const inGame = t.rounds.flat().some((m) => m.status === "playing" && (m.p1 === userId || m.p2 === userId));
  const over = !!t.arenaEndsAt && Date.parse(t.arenaEndsAt) <= Date.now();
  return (
    <div role="status" className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${me.paused ? "border-gold/40 bg-gold/10 text-gold" : "border-neon/40 bg-neon/10"}`}>
      <span className="min-w-0 flex-1">
        {over ? "Temps écoulé : plus de nouvelle partie, classement final dès la fin des parties en cours."
          : inGame ? (me.fire ? "🔥 En série : ta prochaine victoire vaut 4 points !" : "Partie en cours.")
          : me.paused ? "En pause : tu ne reçois plus d'adversaire."
          : "En attente d'un adversaire… (quelques secondes)"}
      </span>
      {!over && (
        <button type="button" disabled={busy} onClick={() => onPause(!me.paused)} className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold ${me.paused ? "border-neon/50 text-neon" : "border-line text-muted hover:text-text"}`}>
          {busy ? "…" : me.paused ? "Reprendre" : "Pause"}
        </button>
      )}
    </div>
  );
}

/** Classement d'une arena : points, série 🔥, feuille de points. */
function ArenaTable({ t, userId }: { t: SngSnapshot; userId: string }) {
  const rows = arenaRows(t);
  const paid = rows.some((r) => r.payoutCents > 0);
  return (
    <div className="panel p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-muted">{t.status === "finished" ? "Classement final" : "Classement"}</h3>
      <ol className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.userId} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${r.userId === userId ? "bg-neon/10" : ""}`}>
            <span className="tabular w-6 shrink-0 text-muted">{r.rank === 1 && t.status === "finished" ? "🏆" : r.rank}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{r.userId}<span className="tabular ml-1.5 text-xs text-muted">{r.rating}</span>{r.fire && <span className="ml-1" title="En série : victoires à 4 points">🔥</span>}{r.team && <span className="ml-1.5 text-[11px] text-gold">{t.teamBattle?.teams.find((x) => x.slug === r.team)?.name ?? r.team}</span>}{r.paused && <span className="ml-1.5 text-xs text-gold">pause</span>}{r.playing && <span className="ml-1.5 text-xs text-neon">●</span>}</span>
              {r.sheet.length > 0 && (
                <span className="tabular flex gap-1.5 overflow-hidden text-[11px] text-muted" aria-label={`Points partie par partie : ${r.sheet.join(", ")}`}>
                  {r.sheet.map((x, i) => <span key={i} className={x === 4 ? "font-bold text-gold" : ""}>{x}</span>)}
                </span>
              )}
            </span>
            {paid && <span className="tabular shrink-0 text-xs text-gold">{r.payoutCents > 0 ? formatMoney(r.payoutCents, t.currency) : ""}</span>}
            <span className="tabular w-9 shrink-0 text-right font-semibold">{r.points}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Arena : les parties, les plus récentes d'abord. */
function ArenaGames({ t, userId }: { t: SngSnapshot; userId: string }) {
  const games = [...(t.rounds[0] ?? [])].reverse();
  const shown = games.slice(0, 12);
  return (
    <details className="panel p-3" open={t.status === "running"}>
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Parties ({games.length})</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {shown.map((m) => {
          const mine = m.p1 === userId || m.p2 === userId;
          const last = m.games.at(-1);
          return (
            <li key={m.slot} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${mine ? "bg-neon/10 ring-1 ring-neon/40" : "bg-surface-2"}`}>
              <span className="size-2.5 shrink-0 rounded-sm border border-line bg-[#f3f3f3]" aria-hidden />
              <span className={`min-w-0 max-w-[36%] truncate ${m.result === "1-0" ? "font-semibold text-win" : ""}`}>{m.p1}</span>
              <span className="text-xs text-muted">–</span>
              <span className="size-2.5 shrink-0 rounded-sm border border-line bg-[#222]" aria-hidden />
              <span className={`min-w-0 max-w-[36%] truncate ${m.result === "0-1" ? "font-semibold text-win" : ""}`}>{m.p2}</span>
              <span className="ml-auto shrink-0 text-xs">
                {m.status === "playing"
                  ? <span className="text-neon">● en jeu{!mine && last && !last.result && <a href={`/direct/${last.gameId}`} target="_blank" rel="noreferrer" className="ml-1.5 rounded bg-neon/15 px-1.5 py-0.5 font-semibold hover:bg-neon/25" title="Regarder la partie">👁</a>}</span>
                  : last ? <a href={`/partie/${last.gameId}`} className="tabular text-muted hover:text-text">{m.result ? swissBoardScore(m) : "annulée"}</a> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {games.length > shown.length && <p className="mt-2 text-xs text-muted">… et {games.length - shown.length} parties plus anciennes.</p>}
    </details>
  );
}

/** Bataille de clubs : classement des clubs (score = N meilleurs joueurs), barres de score, meneurs. */
function TeamBattle({ t, userId }: { t: SngSnapshot; userId: string }) {
  const b = t.teamBattle!;
  const max = Math.max(1, ...b.teams.map((x) => x.score));
  const mine = t.players.find((p) => p.userId === userId)?.team;
  return (
    <div className="panel border-gold/40 p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-gold">⚔️ Bataille de clubs · {b.leaders} meilleurs par club</h3>
      <ol className="flex flex-col gap-2">
        {b.teams.map((c, i) => (
          <li key={c.slug} className={`rounded-lg p-2 ${c.slug === mine ? "bg-gold/10 ring-1 ring-gold/40" : "bg-surface-2"}`}>
            <div className="flex items-baseline gap-2">
              <span className="tabular w-5 text-muted">{i === 0 && t.status === "finished" ? "🏆" : i + 1}</span>
              <a href={`/club/${c.slug}`} className="min-w-0 flex-1 truncate font-semibold hover:underline">{c.name}</a>
              <span className="tabular text-xs text-muted">{c.players} joueur{c.players > 1 ? "s" : ""}</span>
              <span className="tabular w-10 text-right font-display text-lg font-bold">{c.score}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-gold" style={{ width: `${(100 * c.score) / max}%` }} /></div>
            {c.top.length > 0 && <p className="mt-1 truncate text-[11px] text-muted">{c.top.map((x) => `${x.userId} ${x.points}`).join(" · ")}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
