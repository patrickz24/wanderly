# Exercice : les métriques d'évaluation

Cette branche (`learning/eval-metrics`) est un exercice. Les modules ci-dessous ont été vidés :
mêmes signatures, mêmes types, mêmes docstrings, mais chaque corps lève
`Error('TODO(learning): …')` et contient des consignes pas à pas en commentaire. Les tests
existants n'ont pas été modifiés : ce sont eux, la spécification. Ton objectif est de les remettre
au vert, dans l'ordre ci-dessous, sans regarder l'implémentation d'origine (elle est sur `main`).

Le guide complet (concepts, lecture commentée du vrai code, indices progressifs, questions
d'entretien) est sur `main`, dans `docs/learning/eval-metrics.md`. Depuis cette branche :
`git show main:docs/learning/eval-metrics.md`.

## Fichiers à écrire

| Fichier                              | Ce qui est vidé                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `evals/scorers/retrieval-metrics.ts` | pertinence, Recall@k, MRR@k, Hit@k, premier rang pertinent, moyennes, intervalles bootstrap (simple et apparié)    |
| `evals/scorers/trajectory.ts`        | `collectEvidence`, `modelOutputs`                                                                                  |
| `evals/scorers/agent-metrics.ts`     | `scoreRun` et chaque scorer déterministe                                                                           |
| `evals/scorers/agent-summary.ts`     | la partie statistique : `perCaseMeans`, `summarizeMetric`, `percentile`, `compareRuns` (`summarizeRun` est fourni) |

Fourni : les types, `mean`, le générateur pseudo-aléatoire à graine `seededRandom`, `assertK`, les
schémas Zod des sorties d'outils, la liste des métriques, les empreintes du prompt et trois petites
aides de `agent-metrics.ts` (`scored`, `brokeOutputContract`, `sameAmount`).

## Lancer les tests

Depuis `evals`, Vitest sans `run` reste en mode watch et relance à chaque sauvegarde :

```sh
cd evals
npx vitest retrieval-metrics                       # un fichier (filtre sur le nom du fichier)
npx vitest agent-metrics -t "citation_integrity"   # un groupe (regex sur le nom complet)
npx vitest run scorers                             # une seule passe, sans watch
```

Dans le watch, `p` filtre par fichier, `t` par nom de test, `a` relance tout.

## Ordre conseillé

49 tests ciblés, en 9 étapes.

| Étape | À écrire                                                                               | Tests |
| ----: | -------------------------------------------------------------------------------------- | ----: |
|     1 | `retrieval-metrics.ts` : pertinence d'un chunk pour une section étiquetée              |     3 |
|     2 | `retrieval-metrics.ts` : métriques de rang et moyenne macro                            |     5 |
|     3 | `retrieval-metrics.ts` : intervalle bootstrap, différence appariée                     |     2 |
|     4 | `trajectory.ts` : l'index des preuves re-dérivé de la trajectoire (pas de test direct) |     0 |
|     5 | `agent-metrics.ts` : `scoreRun`, type de réponse, validité du schéma, statuts          |     3 |
|     6 | `agent-metrics.ts` : intégrité des citations, nombres ancrés, taux d'erreur des outils |     5 |
|     7 | `agent-metrics.ts` : contraintes, intérêts, clarification dans les deux sens           |     7 |
|     8 | `agent-metrics.ts` : garde-fous, canary, puis l'itinéraire « parfait »                 |     7 |
|     9 | `agent-summary.ts` : moyennes par cas, intervalle, percentile, comparaison appariée    |    17 |

Deux particularités :

- **`scoreRun` appelle tous les scorers.** Un seul `TODO` restant fait échouer chaque test qui
  l'appelle. Pour avancer test par test, remplace d'abord les `throw` des scorers pas encore écrits
  par un `return null` provisoire, puis remplis-les dans l'ordre des étapes. La revue finale
  vérifiera qu'il n'en reste aucun.
- **`agent-summary.test.ts` échoue au chargement** tant que `summarizeMetric` n'est pas écrit : un
  `describe` appelle `summarizeRun` dès la collecte des tests. Commence donc l'étape 9 par
  `perCaseMeans` et `summarizeMetric` ; les 17 tests du fichier apparaissent ensuite.

Les commandes, depuis `evals` :

```sh
npx vitest retrieval-metrics -t relevance                              # étape 1
npx vitest retrieval-metrics -t "rank metrics"                         # étape 2
npx vitest retrieval-metrics -t bootstrap                              # étape 3
npx vitest agent-metrics -t "run statuses"                             # étapes 4 et 5
npx vitest agent-metrics -t "citation_integrity|numbers_grounded"      # étape 6
npx vitest agent-metrics -t "constraint_fit|clarification"             # étape 7
npx vitest agent-metrics -t "guardrails|gold"                          # étape 8
npx vitest agent-summary                                               # étape 9
```

Le test `rank metrics rejects invalid k and queries without targets` échoue sur l'assertion
`toThrow(RangeError)` et non sur le message `TODO(learning)` : c'est normal, l'erreur du squelette
arrive avant.

## Tests qui dépendent de ton code

Ils ne sont pas des cibles de l'exercice, mais ils notent de vraies trajectoires de la boucle :
ils échouent sur le squelette et doivent repasser au vert à la fin.

```sh
cd evals && npx vitest run agent-harness     # 4 tests : contrôles oracle et null notés par scoreRun
```

## Quand tout est vert

1. Retire la ligne `/* eslint-disable … learning skeleton … */` en tête de chaque fichier, les
   commentaires `TODO(learning)` et tout `return null` provisoire.
2. Depuis la racine : `npm test`, `npm run typecheck`, `npx eslint evals/scorers` et
   `npx prettier --check evals/scorers` doivent passer.
3. Contrôle de bout en bout, sans clé API : `npm run eval:controls`. L'oracle doit faire 100 % sur
   chaque métrique applicable, les deux baselines nulles doivent échouer (voir
   `docs/EVALUATIONS.md`).
4. Compare avec l'original : `git diff main -- evals/scorers/`. La grille de relecture est à la fin
   du guide.
5. Demande une revue exigeante à Claude Code (le prompt est dans `docs/LEARNING.md` sur `main`).

Cette branche ne doit jamais être fusionnée dans `main`.
