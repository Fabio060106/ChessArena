# Sprint 2 — Persistance, grand livre, Elo, Sit & Go : rapport de livraison

> 26/10/2026 · Périmètre : PostgreSQL complet, `PgLedger` SERIALIZABLE, Elo à K dynamique, moteur Sit & Go, journal d'audit chaîné en base.
> DoD (ARCHITECTURE.md §8) : *un `kill -9` pendant un règlement ne crée ni ne détruit aucun centime.* ✅ Prouvé par test, voir §3.

## 1. Livrables

| Module | Fichiers | Points clés |
|---|---|---|
| Schéma | `db/migrations/001_init.sql`, `src/db/migrate.ts` | Grand livre en partie double, append-only ; devise garantie par des clés étrangères composites ; soldes tenus par trigger dans la même transaction ; parties, classements, historique, tournois, journal d'audit. Runner de migrations avec verrou consultatif et empreinte SHA-256 de chaque fichier |
| Grand livre | `src/settlement/ledger.ts`, `src/db/tx.ts` | `PgLedger` en SERIALIZABLE avec reprise automatique (40001 / 40P01, backoff + jitter) ; idempotence contrôlée par empreinte du contenu ; erreurs typées ; rapprochement comptable ; remboursement des escrows orphelins |
| Elo | `src/rating/elo.ts`, `src/persistence/GameRepository.ts` | K = 40 / 20 / 10 ; règle FIDE des 400 points ; Elo par cadence ; partie, deux classements et historique écrits dans une seule transaction idempotente |
| Sit & Go | `src/tournaments/SitAndGo.ts`, `TournamentManager.ts`, `TournamentStore.ts` | 4, 6 ou 8 joueurs ; tableau KO à têtes de série (exemptions à 6) ; départage par revanche puis Armageddon ; escrow atomique ; 65 / 35 après rake de 10 % ; dotation sponsor non rakée ; persistance complète ; lobby temps réel (`sng:*`) |
| Audit | `src/audit/auditLog.ts` | `PgAuditLog` bufferisé (hors chemin chaud), écrivain unique garanti par `audit_head FOR UPDATE` même entre instances ; `verifyAuditTable()` lit par pages et compare la fin de chaîne à la tête |
| Récupération | `src/app.ts` (`recover()`) | Au démarrage : tournois interrompus annulés, puis escrows orphelins remboursés à l'identique |

## 2. Invariants du grand livre et où ils sont garantis

| Invariant | Application | Base de données |
|---|---|---|
| **I1** Σ = 0 par lot (rien de créé ni détruit) | `validatePostings` | trigger de contrainte différé, vérifié au COMMIT |
| **I2** Une clé = un lot | `ON CONFLICT` + comparaison d'empreinte → `IdempotencyConflictError` | `UNIQUE (idempotency_key)` |
| **I3** Atomicité | une transaction par lot, rollback sur toute erreur | MVCC PostgreSQL |
| **I4** Étanchéité PLAY / EUR | `CurrencyMismatchError` | `CHECK` sur le suffixe du compte + clés étrangères `(account, currency)` et `(transaction_id, currency)` |
| **I5** Pas de découvert joueur | `InsufficientFundsError` | `CHECK (balance >= 0)` sur `user:*`, vérifié immédiatement |
| Immutabilité | — | triggers interdisant `UPDATE` / `DELETE` sur les écritures, les parties, l'historique Elo et l'audit |

## 3. Tests (127 au total, dont 34 sur un vrai PostgreSQL 16)

Les suites PostgreSQL démarrent un cluster jetable (`initdb`) ou utilisent `TEST_DATABASE_URL`. Si aucun PostgreSQL n'est disponible, elles sont sautées avec un message explicite.

**Grand livre (16)**
- Idempotence ; 20 envois concurrents de la même clé → 1 seul appliqué.
- Double dépense : 10 blocages simultanés sur un solde unique → 1 seul passe.
- 300 virements croisés concurrents ; 200 règlements simultanés sur le compte de rake.
- Contournements SQL (déséquilibre, mélange de devises) rejetés par la base.
- **Trois scénarios de crash** :
  - exception levée avant le `COMMIT` ;
  - backend PostgreSQL tué en pleine transaction ;
  - **`SIGKILL` du process en plein trafic** : chaque transaction annoncée comme confirmée est bien en base, aucune transaction partielle, Σ = 0.
- Remboursement des escrows orphelins, idempotent.

**Sit & Go (14, unitaires)**
- Tableaux 4 / 6 / 8 joueurs, rangs, 65 / 35, rake.
- Départages ; parties annulées (imputées au responsable ou rejouées).
- Course sur la dernière place ; annulation avec remboursement exact, y compris après désinscription puis réinscription.

**Elo (9 unitaires + 6 en base)**
- Transitions du facteur K.
- Idempotence sous 5 envois parallèles.
- Historique continu sous concurrence.
- Parties et historique immuables.

**Audit (5 unitaires + 7 en base)**
- Deux écrivains concurrents produisent une chaîne linéaire.
- Falsifications par un superutilisateur (triggers désactivés) détectées : modification, suppression en fin de table, trou de séquence.

**Bout en bout en base (3)**
- Duel complet.
- Sit & Go à 4 via sockets.
- **Crash avec mises bloquées puis redémarrage** : tous les joueurs sont remboursés et le tournoi est annulé.

## 4. Problèmes trouvés par les tests et corrigés

1. **Point de contention sur `house:rake`.**
   - Chaque règlement mettait à jour la même ligne de solde. Avec 100 règlements simultanés et 4 reprises, **84 échouaient**.
   - Correctif : les comptes `house:*` n'ont plus de solde en cache (lecture par somme des écritures). Résultat : **0 échec** et un traitement 4× plus rapide.
2. **Course dans le vidage du journal d'audit.**
   - `close()` pouvait rendre la main pendant qu'un dernier lot était encore en vol (échec 2 fois sur 6).
   - Correctif : vidage réécrit en boucle explicite ; 8 exécutions sur 8 au vert ensuite.
3. **Erreur de connexion non gérée.** Une connexion PostgreSQL tuée pendant une transaction faisait tomber le process (`ECONNRESET`). La connexion est maintenant marquée pour destruction au lieu d'être rendue au pool.

## 5. Performance (pas de régression)

Test de charge de 500 parties, **avec PostgreSQL** : 0,62 ms au p99 pour le traitement d'un coup (inchangé). Résultat en base : 500 parties, 2 000 lots comptables, 32 379 entrées d'audit, rapprochement à 0. Le règlement, l'Elo et l'audit restent hors du chemin chaud.

## 6. Décisions et écarts

- **`001_init.sql` réécrit** : aucune base n'était déployée. À partir de maintenant, toute évolution passe par une nouvelle migration `002_*.sql` ; le runner refuse une migration déjà appliquée puis modifiée.
- **Identifiants utilisateurs en `TEXT`** (le `sub` du JWT) plutôt qu'en UUID, pour éviter une table de correspondance. Le caractère `:` est interdit car il sert de séparateur dans les noms de comptes.
- **K = 40 prioritaire pour les nouveaux comptes, même au-dessus de 2400** (règle FIDE). Une fois 2400 atteint, K = 10 définitivement : le pic est mémorisé.
- **Départage Armageddon** : la meilleure tête de série a les Noirs et la nulle lui suffit. La partie n'est pas classée Elo.
- **Un tour de KO ne démarre que quand tous ses matchs sont finis**, par équité de repos. Pas de petite finale, donc au plus 2 places payées.

## 7. Limites connues → Sprint 3 et suivants

- **Instance unique** : files, parties et tournois en cours sont en mémoire. Au redémarrage, ils sont annulés et remboursés, sans perte mais sans reprise. Redis et la reprise des tournois en cours arriveront avec le passage multi-instance.
- **Si le règlement final d'un tournoi échoue 5 fois puis que le serveur redémarre**, la récupération rembourse les inscriptions au lieu de payer le podium. Aucune perte d'argent, mais le résultat sportif n'est pas honoré. Correctif prévu : persister le classement final et le payer depuis la base au redémarrage.
- **Rôle applicatif PostgreSQL restreint** : le script `GRANT` / `REVOKE` est documenté en fin de migration, mais pas encore appliqué automatiquement (à faire au Sprint 4).
- **Interface Sit & Go** : les événements temps réel sont prêts, mais il n'y a pas encore d'écran de lobby ni de tableau dans le front.
