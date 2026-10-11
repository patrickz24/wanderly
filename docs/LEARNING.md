# Kit d'apprentissage

Wanderly a été construit avec Claude Code et plusieurs agents en parallèle. Le plan réservait trois
parties au « mode apprentissage » : la boucle agent, le chunking avec la fusion RRF, et les
métriques d'évaluation. Pour aller vite, les agents les ont écrites aussi. Ce kit sert à
rattraper ce choix honnêtement : **comprendre** ces trois parties en profondeur, puis les
**réécrire toi-même** contre les tests existants, pour pouvoir les défendre ligne à ligne en
entretien (« écrivez-moi la boucle au tableau », « pourquoi RRF ? », « votre écart est-il
significatif ? »).

## Ce que contient le kit

| Sujet                  | Guide                                                  | Branche d'exercice      | Ce que tu réécris                                                                                        | Tests ciblés | Tests dépendants |
| ---------------------- | ------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------- | -----------: | ---------------: |
| La boucle agent        | [`learning/agent-loop.md`](learning/agent-loop.md)     | `learning/agent-loop`   | `run-agent.ts`, `user-turn.ts`, `deadline.ts`, l'exécuteur d'outil (`tool.ts`), `validate-response.ts`   |           71 |               12 |
| Chunking et fusion RRF | [`learning/chunking-rrf.md`](learning/chunking-rrf.md) | `learning/chunking-rrf` | `tokens.ts`, `rrf.ts`, le cœur de `chunker.ts`                                                           |           56 |               26 |
| Les métriques d'éval   | [`learning/eval-metrics.md`](learning/eval-metrics.md) | `learning/eval-metrics` | `retrieval-metrics.ts`, `trajectory.ts`, `agent-metrics.ts`, la partie statistique de `agent-summary.ts` |           49 |                4 |

Chaque guide a la même structure : les concepts (le problème, les alternatives, les décisions et
leurs ADR), une lecture guidée du vrai code avec des liens `fichier:ligne`, un plan d'exercice
pas à pas avec des indices progressifs (sans solution complète), des questions d'entretien avec
des réponses modèles, et une grille d'auto-relecture.

## Comment fonctionne un exercice

- Sur chaque branche, les modules ciblés ont été **vidés** : mêmes signatures exportées, mêmes
  types, mêmes docstrings, mais chaque corps lève `Error('TODO(learning): …')` et contient des
  consignes pas à pas en commentaire. Le code qui n'est pas la cible (ports, types, petites aides)
  est conservé, pour que l'exercice reste centré.
- **Les tests n'ont pas été modifiés** : ce sont eux, la spécification. Sur le squelette, les
  tests ciblés échouent avec le message `TODO(learning)`, le reste du dépôt compile
  (`npm run typecheck`) et les autres tests passent, sauf quelques tests « dépendants » qui
  exécutent ton code indirectement (le harnais d'éval, l'ingestion) : ils repassent au vert à la
  fin.
- Le fichier `LEARNING.md` à la racine de chaque branche donne les commandes de chaque étape
  (Vitest en mode watch) et l'ordre dans lequel faire passer les tests.
- Trois règles : ne regarde pas l'implémentation d'origine avant d'avoir fini (elle est sur
  `main`) ; ne modifie pas les tests ; ne fusionne **jamais** une branche d'exercice dans `main`.

Les branches existent dans le dépôt local `C:\dev\wanderly`. Elles n'ont pas été poussées : si tu
veux les retrouver ailleurs, pousse-les toi-même (`git push -u origin learning/agent-loop`, etc.).

## Préparer une branche chez toi

Garde les branches `learning/*` intactes (ce sont les points de départ) et crée une branche à toi
par tentative, dans un _worktree_ séparé, pour ne pas toucher à ton arbre de travail principal :

```sh
cd C:/dev/wanderly
git worktree add ../wanderly-ex-agent-loop -b exercise/agent-loop-1 learning/agent-loop
cd ../wanderly-ex-agent-loop
npm ci            # installe les dépendances de ce worktree
npx husky         # installe les hooks de commit dans ce worktree
```

Sous Windows, tu peux éviter la réinstallation en réutilisant les dépendances de `main` avec des
jonctions (depuis la racine du worktree, dans Git Bash) :

```sh
cmd //c "mklink /J node_modules ..\\wanderly\\node_modules"
mkdir -p apps/web/node_modules && cd apps/web/node_modules
cmd //c "mklink /J @vitejs ..\\..\\..\\..\\wanderly\\apps\\web\\node_modules\\@vitejs"
```

Les paquets du monorepo (`@wanderly/contracts`) sont alors résolus depuis `C:\dev\wanderly` :
c'est sans conséquence tant que les contrats ne changent pas. Committe ton travail sur ta branche
au fil de l'eau. Pour recommencer à zéro, crée `exercise/agent-loop-2` depuis `learning/agent-loop`.
Quand tu as fini : `git worktree remove ../wanderly-ex-agent-loop` (la branche reste).

## Planning suggéré

Trois séances de 2 h 30 à 3 h, une par sujet, puis une courte séance d'oral. La boucle agent est
la plus longue : si elle déborde, finis-la au début de la séance suivante plutôt que de la bâcler.

| Séance                  | Durée  | Déroulé                                                                                                                                                                                                                                                                                |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. La boucle agent      | 3 h    | 30 min : partie 1 du guide et ADR [0006](adr/0006-hand-written-agent-runtime.md), [0007](adr/0007-llm-provider-abstraction-and-opaque-blocks.md), [0009](adr/0009-structured-output-through-terminal-tools.md). 2 h : étapes 1 à 10. 30 min : partie 2, grille, revue par Claude Code. |
| 2. Chunking et RRF      | 2 h 30 | 20 min : partie 1 et ADR [0003](adr/0003-corpus-and-structure-aware-chunking.md), [0005](adr/0005-hybrid-retrieval-with-rrf.md). 1 h 45 : étapes 1 à 6 (RRF d'abord, c'est un bon échauffement). 25 min : partie 2, grille, revue.                                                     |
| 3. Les métriques d'éval | 2 h 30 | 20 min : partie 1, ADR [0012](adr/0012-evaluation-strategy-and-ci-gates.md) et [EVALUATIONS.md](EVALUATIONS.md). 1 h 45 : étapes 1 à 9, puis `npm run eval:controls`. 25 min : partie 2, grille, revue.                                                                                |
| 4. L'oral               | 1 h    | Les questions d'entretien des trois guides, à voix haute, sans notes ; puis au tableau, de mémoire : `withDeadline`, la boucle en pseudo-code, RRF, Recall@k et un bootstrap. Termine par [INTERVIEW_NOTES.md](INTERVIEW_NOTES.md).                                                    |

Ordre conseillé dans chaque séance : les concepts, puis l'exercice (les indices seulement quand tu
bloques), puis la lecture guidée pour comparer, puis la grille. Lire la lecture guidée avant
l'exercice revient à recopier.

## Demander une revue exigeante à Claude Code

Quand les tests d'une branche passent, lance Claude Code **dans le worktree de l'exercice** et
colle ce message (adapte le sujet et la liste de fichiers ; elle est dans le `LEARNING.md` de la
branche) :

```text
Tu es un reviewer senior exigeant, spécialiste des agents LLM et du TypeScript strict. Je viens de
réimplémenter moi-même, pour un exercice, <la boucle agent | le chunker et RRF | les métriques
d'éval> de Wanderly. L'implémentation d'origine est sur la branche main ; le guide est
docs/learning/<agent-loop | chunking-rrf | eval-metrics>.md sur main.

1. Lis le guide (git show main:docs/learning/<sujet>.md), puis compare ma version à l'originale :
   git diff main -- <fichiers de l'exercice>.
2. Ne réécris pas mon code et ne me donne pas de solution complète. Pour chaque problème : le
   fichier et la ligne, la gravité (bloquant, important, mineur), un scénario concret qui le
   déclenche, et une piste de correction en une phrase.
3. Vérifie en priorité : la correction, les cas limites que les tests ne couvrent pas (propose
   des tests supplémentaires à écrire), chaque différence de comportement avec l'original et si
   elle est acceptable, le typage strict (pas de any, pas de !, pas de as injustifié), la
   lisibilité, et la grille d'auto-relecture de la partie 5 du guide, point par point.
4. Lance npm test, npm run typecheck et npx eslint sur les fichiers, et rapporte les vrais
   résultats.
5. Ensuite, pose-moi une par une cinq questions d'entretien difficiles sur MES choix
   d'implémentation (pas des questions de cours). Attends ma réponse à chacune, note-la sur 5 et
   dis-moi ce qu'un recruteur exigeant aurait voulu entendre.
6. Termine par un verdict : est-ce que je peux défendre ce code en entretien ? Qu'est-ce que je dois
   retravailler avant ?
```

Corrige toi-même ce que la revue trouve, ajoute les tests qu'elle propose s'ils sont pertinents,
puis relance la revue. Si ta version de Claude Code propose la commande `/code-review`, elle peut
compléter ce message, pas le remplacer : elle cherche des bugs, elle ne t'interroge pas.

## Après le kit : comment en parler

Ne dis « je l'ai réécrit moi-même » que si c'est vrai. Une formulation honnête une fois le kit
fait : « J'ai piloté la construction avec des agents de code. Ensuite, j'ai vidé la boucle agent,
le chunker, la fusion RRF et les métriques d'éval, et je les ai réécrits moi-même contre la suite
de tests existante, pour pouvoir les défendre ligne à ligne. » Voir aussi la section 8 de
[INTERVIEW_NOTES.md](INTERVIEW_NOTES.md#8-comment-le-projet-a-été-construit).
