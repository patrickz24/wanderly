# Exercice : la boucle agent

Cette branche (`learning/agent-loop`) est un exercice. Les modules ci-dessous ont été vidés : mêmes
signatures, mêmes types, mêmes docstrings, mais chaque corps lève `Error('TODO(learning): …')` et
contient des consignes pas à pas en commentaire. Les tests existants n'ont pas été modifiés : ce
sont eux, la spécification. Ton objectif est de les remettre au vert, dans l'ordre ci-dessous,
sans regarder l'implémentation d'origine (elle est sur `main`).

Le guide complet (concepts, lecture commentée du vrai code, indices progressifs, questions
d'entretien) est sur `main`, dans `docs/learning/agent-loop.md`. Depuis cette branche :
`git show main:docs/learning/agent-loop.md`, ou ouvre-le dans un autre onglet de l'éditeur.

## Fichiers à écrire

| Fichier                                                   | Ce qui est vidé                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `services/api/src/domain/agent/user-turn.ts`              | `buildUserTurn`, `answerOpenCalls`, `contextBlock`, `serializeBrief`                      |
| `services/api/src/domain/agent/deadline.ts`               | `withDeadline`, `startRunDeadline`                                                        |
| `services/api/src/domain/tools/tool.ts`                   | la méthode `run` de `defineDataTool` (rien d'autre)                                       |
| `services/api/src/domain/guardrails/validate-response.ts` | `validateResponse`                                                                        |
| `services/api/src/domain/agent/run-agent.ts`              | `runAgent`, les méthodes principales de `AgentRun`, `repairMessage`, `toolFailureMessage` |

Tout le reste est fourni et ne doit pas bouger : les ports (`domain/ports/`), les messages
(`messages.ts`), les limites (`limits.ts`), les types du run (`types.ts`), le registre d'outils,
les outils eux-mêmes, les règles de cohérence et d'ancrage (`consistency.ts`, `grounding.ts`), le
prix des appels (`pricing.ts`), et les faux ports des tests (`services/api/test/support/`).

## Lancer les tests

Depuis `services/api`, Vitest sans `run` reste en mode watch et relance à chaque sauvegarde :

```sh
cd services/api
npx vitest user-turn                         # un fichier (filtre sur le nom du fichier)
npx vitest run-agent.test -t "happy path"    # un groupe (regex sur le nom complet du test)
npx vitest run user-turn deadline            # une seule passe, sans watch
```

Dans le watch, `p` filtre par fichier, `t` par nom de test, `a` relance tout.

## Ordre conseillé

71 tests ciblés, en 10 étapes. Chaque étape s'appuie sur les précédentes. Les commentaires
`TODO(learning)` de `run-agent.ts` portent le numéro de l'étape où chaque méthode devient
nécessaire.

| Étape | À écrire                                                             | Tests |
| ----: | -------------------------------------------------------------------- | ----: |
|     1 | `user-turn.ts` : le tour utilisateur                                 |     5 |
|     2 | `deadline.ts` : `withDeadline`, `startRunDeadline`                   |     8 |
|     3 | `tool.ts` : `run` (arguments du modèle, vue de trace)                |    15 |
|     4 | `validate-response.ts`                                               |     2 |
|     5 | `run-agent.ts` : le chemin heureux                                   |     9 |
|     6 | `run-agent.ts` : outils en échec, délai d'outil                      |     3 |
|     7 | `run-agent.ts` : validation, réparation, rappel                      |    10 |
|     8 | `run-agent.ts` : canary, signaux d'injection, tour suivant           |     3 |
|     9 | `run-agent.ts` : échecs du modèle (délais, panne, refus, troncature) |     7 |
|    10 | `run-agent.ts` : pas, plafond de coût, append-only, annulation       |     9 |

Les commandes, depuis `services/api` :

```sh
npx vitest user-turn                                                  # étape 1
npx vitest deadline                                                   # étape 2
npx vitest data-tools                                                 # étape 3
npx vitest guardrails.test -t validateResponse                        # étape 4
npx vitest run-agent.test -t "happy path"                             # étape 5
npx vitest run-agent.test -t "tool errors"                            # étape 6
npx vitest run-agent.test -t "terminal output validation"             # étape 7
npx vitest run-agent.test -t "guardrail signals|follow-up"            # étape 8
npx vitest run-agent.limits -t "model failures"                       # étape 9
npx vitest run-agent.limits -t "limits|append-only|cancellation"      # étape 10
```

Un test de l'étape 9 (`rethrows unexpected errors`) échoue sur l'assertion `toThrow(TypeError)` et
non sur le message `TODO(learning)` : c'est normal, l'erreur du squelette arrive avant.

## Tests qui dépendent de ton code

Ces tests ne sont pas des cibles de l'exercice, mais ils exécutent la vraie boucle : ils échouent
sur le squelette et doivent repasser au vert à la fin.

```sh
cd evals && npx vitest run agent-harness     # 12 tests : contrôles oracle et null, pannes d'infra, traces d'éval
```

## Quand tout est vert

1. Retire la ligne `/* eslint-disable … learning skeleton … */` en tête de chaque fichier (et le
   commentaire `eslint-disable-next-line` de `tool.ts`), puis les commentaires `TODO(learning)`.
2. Depuis la racine : `npm test`, `npm run typecheck`, `npx eslint services/api/src/domain` et
   `npx prettier --check services/api/src/domain` doivent passer.
3. Compare avec l'original : `git diff main -- services/api/src/domain/agent/run-agent.ts` (et les
   autres fichiers). La grille de relecture est à la fin du guide.
4. Demande une revue exigeante à Claude Code (le prompt est dans `docs/LEARNING.md` sur `main`).

Cette branche ne doit jamais être fusionnée dans `main`.
