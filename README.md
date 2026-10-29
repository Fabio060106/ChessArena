# ChessArena — boilerplate MVP

Plateforme de compétition d'échecs. Le dépôt contient le chemin critique fonctionnel :
matchmaking Elo → partie temps réel → règlement avec rake → journal d'audit chaîné → analyse anti-triche Stockfish.

- Spécification complète, arborescence et plan de sprints : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Rapports de sprint : [`docs/SPRINT1.md`](docs/SPRINT1.md) (boucle de jeu), [`docs/SPRINT2.md`](docs/SPRINT2.md) (PostgreSQL, ledger, Elo, Sit & Go), [`docs/SPRINT3.md`](docs/SPRINT3.md) (anti-triche, WITHDRAWAL_HOLD, back-office, calibration)
- Mode argent réel **désactivé par défaut** (`REAL_MONEY_ENABLED=0`) — lire la section 6 de la spec.

## Démarrer (Sprint 1 : boucle de jeu PLAY)

```bash
npm install && (cd apps/web && npm install)
npm test                 # game-server (unitaires + intégration), analysis, web
npm run loadtest         # 500 parties simultanées, vérifie p99 < 5 ms

# terminal 1 — game-server (même secret que le front)
JWT_SECRET=change-me-dev-secret-change-me-dev-secret ANALYSIS_ENABLED=0 npm run dev:game

# terminal 2 — front
cd apps/web && cp .env.example .env.local && npm run dev
```

Ouvrir `http://localhost:3000/play?u=alice` et `http://localhost:3000/play?u=bob` dans **deux navigateurs** (ou une fenêtre privée), choisir la même cadence et la même mise.
En dev, le front obtient un JWT via `/api/dev-token` (désactivé en production) ; le game-server vérifie toujours la signature.

Commandes du plateau : glisser-déposer ou clic-clic ; jouer pendant le tour adverse = **pré-move** (clic droit pour l'annuler).

## Anti-triche (Sprint 3)

```bash
# Redis + PostgreSQL requis
export DATABASE_URL=postgres://… REDIS_URL=redis://localhost:6379
REDIS_URL=$REDIS_URL npm run dev:game                 # producteur de la file + application des verdicts
STOCKFISH_CMD=stockfish npm run dev:analysis          # API :4100 + worker (1 moteur par cœur)
npm run worker -w @chessarena/analysis                # workers supplémentaires (sans API)
```

Back-office : `http://localhost:3000/admin/anticheat` (en dev, identité `moderator-dev` ; même `JWT_SECRET` côté web et game-server).
Sans binaire natif, les tests utilisent Stockfish 19 WASM (`stockfish` npm). Calibration : voir `services/analysis/scripts/calibrate.ts`.

## Avec PostgreSQL (Sprint 2)

```bash
docker compose -f infra/docker-compose.yml up -d postgres
export DATABASE_URL=postgres://chessarena:chessarena@localhost:5432/chessarena
npm run db:migrate       # ou MIGRATE_ON_START=1 au lancement du game-server
JWT_SECRET=… ANALYSIS_ENABLED=0 npm run dev:game
```

Sans `DATABASE_URL`, le serveur utilise des implémentations mémoire équivalentes (mêmes invariants, mêmes erreurs).
Au démarrage avec une base, le serveur annule les tournois interrompus et rembourse tout escrow resté ouvert.

**Tests PostgreSQL / Redis** : `npm test` démarre automatiquement un cluster PostgreSQL jetable (et un `redis-server` sur un port libre) si les binaires PostgreSQL ≥ 15 sont présents
(`initdb` via `PG_BIN`, `pg_config` ou `/usr/lib/postgresql/<v>/bin`). Sinon, fournir `TEST_DATABASE_URL`
(rôle autorisé à `CREATE DATABASE`). Sans l'un ni l'autre, les suites PostgreSQL sont sautées.

## Conformité (Sprint 4)

KYC, limites de jeu responsable appliquées dans la transaction comptable, géo-filtre et kill-switch argent réel
(propagé à chaud entre instances), export réglementaire signé (SHA-256 + Ed25519). Détails, matrice des modes de
session et **réserves juridiques** : [`docs/SPRINT4.md`](docs/SPRINT4.md).

```bash
npm run export:regulatory -w @chessarena/game-server -- --from 2026-10-01 --to 2026-11-01 --out ./exports/2026-10
npm run export:regulatory -w @chessarena/game-server -- --verify ./exports/2026-10
```

L'argent réel exige PostgreSQL et reste fermé tant que `REAL_MONEY_ENABLED=1` **et** la consigne en base
(`POST /admin/compliance/kill-switch`, rôle `compliance`) ne l'ouvrent pas pour un pays présent dans `REAL_MONEY_COUNTRIES`.

## Variables d'environnement (game-server)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 4000 | port WebSocket |
| `JWT_SECRET` | — | obligatoire hors DEV_AUTH |
| `DEV_AUTH` | 0 | `1` = auth par `userId` en clair (refusé en production) |
| `DATABASE_URL` | — | vide = ledger, parties, Elo, tournois et audit en mémoire |
| `RAKE_BPS` | 1000 | rake en points de base (1000 = 10 %) |
| `REAL_MONEY_ENABLED` | 0 | interrupteur global argent réel |
| `REAL_MONEY_COUNTRIES` | — | codes ISO des pays autorisés, renseignés seulement après avis juridique |
| `ANALYSIS_URL` | http://localhost:4100 | service anti-triche |
| `AUDIT_LOG_PATH` | ./var/audit.jsonl | journal chaîné |
| `ANALYSIS_ENABLED` | 1 | `0` = ne pas envoyer les parties au service d'analyse |
| `MIGRATE_ON_START` | 0 | `1` = appliquer les migrations SQL au démarrage |
| `REDIS_URL` | — | file BullMQ d'analyse + verdicts fair-play (sinon envoi HTTP au service d'analyse) |
| `QUEUE_PREFIX` | arena | préfixe des clés BullMQ |
| `WITHDRAWAL_INTERVAL_MS` | 60000 | période d'exécution des retraits |
| `TRUSTED_PROXIES` | — | CIDR des proxys / LB dont on lit `X-Forwarded-For` et l'en-tête pays (sinon ignorés) |
| `GEOIP_CSV_PATH` | — | base IP → pays (`network,country_iso_code`) ; vide = pays inconnu → jetons uniquement |
| `EDGE_COUNTRY_HEADER` | — | en-tête pays posé par l'edge (ex. `cf-ipcountry`), lu seulement via proxy de confiance |
| `KYC_WEBHOOK_SECRET` | — | secret HMAC des webhooks KYC (≥ 32 caractères en production avec argent réel) |
| `EXPORT_SIGNING_KEY` | — | clé Ed25519 PEM PKCS#8 des exports réglementaires (obligatoire en production avec argent réel) |

Points de supervision : `GET /health`, `GET /metrics` (latence de traitement des coups p50/p95/p99, retard de boucle d'événements, parties actives, files).
