# Exercice : chunking et fusion RRF

Cette branche (`learning/chunking-rrf`) est un exercice. Les modules ci-dessous ont été vidés :
mêmes signatures, mêmes types, mêmes docstrings, mais chaque corps lève
`Error('TODO(learning): …')` et contient des consignes pas à pas en commentaire. Les tests
existants n'ont pas été modifiés : ce sont eux, la spécification. Ton objectif est de les remettre
au vert, dans l'ordre ci-dessous, sans regarder l'implémentation d'origine (elle est sur `main`).

Le guide complet (concepts, lecture commentée du vrai code, indices progressifs, questions
d'entretien) est sur `main`, dans `docs/learning/chunking-rrf.md`. Depuis cette branche :
`git show main:docs/learning/chunking-rrf.md`.

## Fichiers à écrire

| Fichier                                  | Ce qui est vidé                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/api/src/domain/rag/tokens.ts`  | `estimateTokens` (les deux regex d'origine ont été retirées : à toi de les écrire)                                                                                                                         |
| `services/api/src/domain/rag/rrf.ts`     | `reciprocalRankFusion`, `compare`                                                                                                                                                                          |
| `services/api/src/domain/rag/chunker.ts` | `chunkMarkdown`, `parseSections`, `areSiblings`, `mergeSmallSiblings`, `mergeUnits`, `withHeading`, `splitUnit`, `absorbSmallTail`, `overlapFrom`, `splitSentences`, `trailingSentences`, `splitParagraph` |

Fourni dans `chunker.ts` : les types, les options et leur validation, l'empreinte, la fabrique
`markdownChunker`, les expressions régulières, le découpage des lignes en blocs (`toBlocks` :
paragraphes, éléments de liste avec leurs lignes de suite, citations, code, titres collés au bloc
suivant) et les petites aides (`toUnit`, `commonPrefix`, `sumTokens`, `joinBlocks`, `isBlank`).

## Lancer les tests

Depuis `services/api`, Vitest sans `run` reste en mode watch et relance à chaque sauvegarde :

```sh
cd services/api
npx vitest tokens                                  # un fichier (filtre sur le nom du fichier)
npx vitest chunker -t "merging small sections"     # un groupe (regex sur le nom complet)
npx vitest run tokens rrf chunker                  # une seule passe, sans watch
```

Dans le watch, `p` filtre par fichier, `t` par nom de test, `a` relance tout.

## Ordre conseillé

56 tests ciblés, en 6 étapes.

| Étape | À écrire                                                                                                     | Tests |
| ----: | ------------------------------------------------------------------------------------------------------------ | ----: |
|     1 | `tokens.ts` : l'estimation de tokens                                                                         |     3 |
|     2 | `rrf.ts` : la fusion par rangs et son ordre déterministe                                                     |    15 |
|     3 | `chunker.ts` : `parseSections` + un `chunkMarkdown` minimal (un chunk par section, sans fusion ni découpage) |    17 |
|     4 | `chunker.ts` : fusion des petites sections sœurs                                                             |     7 |
|     5 | `chunker.ts` : `splitSentences`                                                                              |     2 |
|     6 | `chunker.ts` : découpage des longues sections, chevauchement, queue absorbée                                 |    12 |

L'étape 3 compte 17 tests : les 9 du groupe « one chunk per section », les 6 de
`validateChunkingOptions` (ils vérifient aussi que `chunkMarkdown` refuse des options invalides),
`markdownChunker` et le test avec l'estimateur par défaut. À l'étape 6, quelques tests (ceux qui ne
demandent aucun découpage) passent déjà.

Les commandes, depuis `services/api` :

```sh
npx vitest tokens                                                         # étape 1
npx vitest rrf                                                            # étape 2
npx vitest chunker -t "one chunk per section|validateChunkingOptions|markdownChunker|default token"   # étape 3
npx vitest chunker -t "merging small sections"                            # étape 4
npx vitest chunker -t splitSentences                                      # étape 5
npx vitest chunker -t "splitting long sections"                           # étape 6
```

Les tests `rejects k = …`, `rejects limit = …` (RRF) et `validateChunkingOptions rejects …`
échouent sur une assertion `toThrow(RangeError)` et non sur le message `TODO(learning)` : c'est
normal, l'erreur du squelette arrive avant.

## Tests qui dépendent de ton code

Ils ne sont pas des cibles de l'exercice, mais ils utilisent le chunker ou l'estimation de tokens :
ils échouent sur le squelette et doivent repasser au vert à la fin.

```sh
cd services/api && npx vitest run ingest-corpus           # 11 tests : l'ingestion du corpus
cd evals && npx vitest run agent-harness runner-parts     # 15 tests : connaissance en mémoire, chunker de référence
```

La fusion RRF n'a pas d'autre test unitaire : elle sert dans `PgRetriever`, couvert par les tests
d'intégration (`npm run test:integration`, Postgres + pgvector requis).

## Quand tout est vert

1. Retire la ligne `/* eslint-disable … learning skeleton … */` en tête de chaque fichier, puis
   les commentaires `TODO(learning)`.
2. Depuis la racine : `npm test`, `npm run typecheck`, `npx eslint services/api/src/domain/rag` et
   `npx prettier --check services/api/src/domain/rag` doivent passer.
3. Compare avec l'original : `git diff main -- services/api/src/domain/rag/`. La grille de
   relecture est à la fin du guide.
4. Demande une revue exigeante à Claude Code (le prompt est dans `docs/LEARNING.md` sur `main`).

Cette branche ne doit jamais être fusionnée dans `main`.
