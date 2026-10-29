# Sprint 1 — Boucle de jeu temps réel 1v1 (PLAY) : rapport de livraison

> 25/10/2026 · Périmètre : gateway WebSocket, cœur de partie, matchmaker, front de jeu.
> DoD (ARCHITECTURE.md §8) : 0 coup illégal accepté, traitement serveur **p99 < 5 ms à 500 parties simultanées**.

## 1. Résultat de la DoD

Test de charge `npm run loadtest -w @chessarena/game-server` : serveur et 1 000 clients simulés dans deux process distincts, sur la même machine de 2 vCPU.

| Mesure | 500 parties | 1 000 parties |
|---|---|---|
| Parties terminées | 500 / 500 | 1 000 / 1 000 |
| Pic de parties simultanées | 500 | 1 000 |
| Coups traités / refusés | 29 839 / 0 | 39 905 / 0 |
| **Traitement d'un coup — p50 / p99** | **0,25 / 0,63 ms** | 0,24 / 1,03 ms |
| Retard de boucle d'événements — p99 | 19 ms | 27 ms |
| Mémoire serveur (RSS) | 222 Mo | ≈ 330 Mo |

**DoD respectée, avec une marge d'un facteur 8 sur le p99.** L'aller-retour mesuré côté clients simulés (p50 ≈ 70 ms) reflète surtout la saturation du CPU partagé par 1 000 clients sur 2 vCPU ; ce n'est pas une latence réseau représentative.

### Optimisation faite pendant le sprint
La première mesure donnait un p99 de 4,2 ms (DoD tout juste respectée) et des blocages de la boucle d'événements jusqu'à 500 ms. Le profil CPU montrait que `chess.js` consommait ~1,5 ms par coup. Corrections :
- validation par `chess.move({from,to})` au lieu de `moves({ verbose: true })`, qui calculait la notation SAN de chaque coup légal (≈ 30× plus coûteux) ;
- une seule génération de coups pour détecter la fin de partie, au lieu de deux avec `isGameOver()` ;
- matchmaker en O(n log n) : tri par Elo et recherche des voisins (2 000 joueurs en file appariés en 3 ms) ;
- journal d'audit en flux continu, au lieu d'ouvrir et fermer le fichier à chaque ligne ;
- règlement et création de partie différés par `setImmediate`, hors du chemin chaud.

## 2. Livrables

| Module | Fichiers | Points clés |
|---|---|---|
| Gateway WS | `src/app.ts`, `src/server.ts`, `src/auth.ts`, `src/validation.ts`, `src/net/*` | Factory testable ; JWT HS256 vérifié au handshake ; `canPlay()` à chaque `queue:join` ; validation stricte des payloads ; limitation de débit par socket (rafale 20, puis 10/s) ; isolation des exceptions ; `/health` et `/metrics` |
| Cœur de partie | `src/game/GameRoom.ts`, `src/game/clock.ts`, `src/game/GameManager.ts` | Légalité stricte des coups UCI (pièce de promotion superflue refusée) ; anti-rejeu par numéro de demi-coup ; pendule autoritaire avec incrément ; compensation de lag ≤ 250 ms ; annulation sans rake sous 2 demi-coups ; grâce de reconnexion de 30 s puis forfait ; nulle FIDE quand le temps tombe face à un roi seul |
| Matchmaker | `src/matchmaking/Matchmaker.ts` | Files séparées par cadence × devise × mise ; fenêtre ±50 Elo, +25/s, plafond ±400, acceptée par les deux joueurs ; tick toutes les 1 s |
| Front | `hooks/useGameSocket.ts`, `lib/*`, `components/*`, `app/play/page.tsx` | Reducer pur (état serveur vs affiché) ; coups optimistes avec retour arrière sur ack ; pré-moves ; clic-clic, glisser-déposer et sous-promotion ; pendule extrapolée ; signaux de focus dédupliqués ; resynchronisation à la reconnexion |

## 3. Tests

| Suite | Outil | Tests |
|---|---|---|
| `GameRoom` (légalité, fins, annulation, pendule, lag, déconnexion) | Vitest + horloge simulée | 27 |
| `Matchmaker` (séparation, fenêtre, équité, volume, robustesse) | Vitest | 11 |
| Auth, `canPlay`, validation, limitation de débit, `LagTracker` | Vitest | 10 |
| Rake, journal d'audit | Vitest | 7 |
| **Intégration** : vrai serveur socket.io, vrais clients, vrais JWT | Vitest | 11 |
| Front : horloge, coups locaux, pré-moves, reducer | Vitest | 11 |
| **E2E navigateur** : 2 Chromium, clic-clic, glisser, pré-move, mat, écrans de fin | Playwright (manuel, hors CI) | ✓ |

Lancement : `npm test` à la racine, et `npm test` dans `apps/web`.

## 4. Écarts par rapport à la spécification, et pourquoi

1. **Le lag est mesuré par le serveur et non déclaré par le client.**
   - Le serveur envoie une sonde `lag:probe` toutes les 2 s.
   - On retient le meilleur des 5 derniers RTT, divisé par 2.
   - Avec le minimum, un client qui retarde exprès ses réponses pour obtenir plus de compensation n'y gagne rien.
2. **Le timer de chute attend 250 ms de plus que le temps restant**, pour qu'un coup déjà en route puisse arriver et être compensé avant que la défaite au temps soit déclarée.
3. **Les deux premiers demi-coups ne sont pas chronométrés** (convention Lichess). Chaque camp a 20 s pour jouer le sien, sinon la partie est annulée.
4. **Statut de compte dans le JWT.**
   - Un compte `suspended` ou `closed` ne peut rien jouer.
   - Un compte `self_excluded` peut jouer en PLAY seulement.
   - Un compte `withdrawal_hold` peut jouer, mais ses retraits restent bloqués (ADR-7).

## 5. Limites connues → Sprint 2

- **Instance unique** : files et parties sont en mémoire. Le passage à Redis (files partagées, adaptateur socket.io, sessions persistantes) est la tâche S2.
- **Un redémarrage du serveur pendant une partie** laisse les mises bloquées en escrow. S2 doit ajouter la persistance des parties actives et une tâche de remboursement idempotente.
- **Pas d'Elo persistant**, pas de proposition de nulle, pas de liste des coups en notation SAN dans l'interface.
- **Pic ponctuel de la boucle d'événements (~200 ms)** quand des centaines de parties sont créées dans le même tick. Sans effet sur le p99 ; à lisser au S2 en créant les parties par lots.
- **L'authentification utilise `/api/dev-token`**, désactivé en production. Il sera remplacé par la session NextAuth au S2.
