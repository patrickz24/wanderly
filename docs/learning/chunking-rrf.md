# Guide d'apprentissage : chunking et fusion RRF

Ce guide t'accompagne pour comprendre en profondeur comment Wanderly découpe son corpus en chunks,
estime leur taille en tokens, et fusionne la recherche vectorielle et la recherche plein texte avec
la _Reciprocal Rank Fusion_ (RRF), puis pour réécrire ces trois modules sur la branche
`learning/chunking-rrf`. Il fait partie du [kit d'apprentissage](../LEARNING.md).

- **Partie 1, les concepts** : le problème, les alternatives, les décisions (avec les ADR et les
  chiffres mesurés).
- **Partie 2, la lecture guidée** du vrai code, et pourquoi chaque test existe.
- **Partie 3, l'exercice** : six étapes dans l'ordre des tests, avec des indices progressifs.
- **Partie 4, les questions d'entretien** sur ce sujet, avec des réponses modèles.
- **Partie 5, la grille d'auto-relecture**.

Ordre conseillé : partie 1, puis l'exercice (partie 3), puis la partie 2 pour comparer, puis la
grille et les questions.

> Les références `fichier:ligne` pointent vers `main` au commit `912b95d`. Si `main` a bougé
> depuis, une ligne peut s'être décalée de quelques rangs : cherche le nom de la fonction.

## Partie 1 : les concepts

### 1.1 Le problème

L'agent ne doit affirmer que ce que ses outils lui renvoient. Pour les guides de voyage, l'outil
est `search_knowledge` : une recherche dans 89 documents Wikivoyage découpés en 2 136 chunks.
Le chunking décide **ce qu'est un résultat de recherche** :

- **trop gros**, un chunk mélange plusieurs sujets : son embedding devient une moyenne floue, il
  remonte moins bien, et il remplit le contexte de l'agent de texte inutile ;
- **trop petit**, il perd ce qui le rend trouvable : « 2 small ski stations » ne veut rien dire sans
  « Sicily > Do > Skiing » ;
- **coupé au mauvais endroit**, il sépare un nom de lieu de sa description et de son prix ;
- et il doit tenir dans la fenêtre du modèle d'embedding (512 tokens pour `bge-small-en-v1.5`) :
  au-delà, le texte est tronqué sans bruit.

Le plan demandait que la taille soit **mesurée**, pas posée a priori, et que les étiquettes de
l'éval survivent à un changement de chunking
([ADR 0003](../adr/0003-corpus-and-structure-aware-chunking.md)).

Ensuite, une fois les chunks indexés, il faut les **retrouver**. Les requêtes de voyage mélangent
deux besoins ([ADR 0005](../adr/0005-hybrid-retrieval-with-rrf.md)) :

- des **noms exacts** qu'un petit modèle d'embedding représente mal (« Benagil », « GR 20 ») : la
  recherche lexicale (plein texte) les trouve ;
- des **paraphrases** qui ne partagent aucun mot avec le guide (« walks along old irrigation
  channels » pour les levadas de Madère) : la recherche vectorielle les trouve.

D'où deux listes classées, à fusionner. Et leurs scores ne sont pas comparables : une distance
cosinus d'un côté, un `ts_rank_cd` de l'autre.

### 1.2 Les stratégies de chunking

| Stratégie                                       | Principe                                                                   | Pour                                 | Contre                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Fenêtres fixes avec chevauchement               | N tokens, puis on recule de M et on recommence                             | Simple, tailles régulières           | Coupe au milieu d'une idée ou d'une fiche, ignore la structure ; c'est la **baseline** mesurée |
| Séparateurs récursifs                           | Paragraphe, puis ligne, puis phrase, jusqu'à tenir dans la taille          | Garde les paragraphes entiers        | Ignore les titres, alors que ce corpus en a partout                                            |
| **Conscient de la structure Markdown** (retenu) | Une section `##`/`###` = un chunk, fusion des petites, découpe des longues | Unités de sens, fil d'Ariane naturel | Dépend d'un Markdown bien structuré ; certains chunks fusionnés couvrent deux sujets           |
| Sémantique                                      | Couper là où la similarité entre phrases voisines chute                    | Suit le sens, même sans titres       | Un embedding par phrase à l'ingestion, pour un gain qu'il faudrait d'abord mesurer ; roadmap   |

Le résultat mesuré (53 requêtes, recherche vectorielle, différences appariées sur les mêmes
requêtes, [EVALUATIONS.md](../EVALUATIONS.md#results)) : le chunker par structure gagne
**+10,4 points de Recall@5 (IC 95 % de 2,8 à 18,9)** et **+11,7 points de MRR@10 (IC de 1,1 à
21,7)** face à des fenêtres fixes de 300 tokens avec 40 de chevauchement. Ce que ça ne prouve
pas : les paramètres (300 / 450 / 30 / 60) sont les valeurs de départ du plan, validées contre la
baseline seulement. Aucun balayage des tailles n'a été fait.

### 1.3 Les décisions du chunker

1. **Une section par `##` et `###`** ; les titres plus profonds restent dans leur section, collés
   au bloc qui les suit.
2. **Fusion des petites sections sœurs** (sous `minTokens` = 60) tant que le résultat tient dans
   `targetTokens` (300). Le chunk fusionné prend comme fil d'Ariane le parent commun, et liste
   toutes les sections qu'il couvre.
3. **Découpe des longues sections** (au-delà de `maxTokens` = 450) entre paragraphes et éléments
   de liste, vers la cible, avec jusqu'à 30 tokens de **chevauchement** (des blocs entiers, ou les
   dernières phrases d'un paragraphe). Un **élément de liste n'est jamais coupé** : sur Wikivoyage,
   c'est une fiche (nom, description, prix). Un paragraphe trop long est coupé entre phrases.
4. **_Contextual chunk header_** : « Sicily > Do > Skiing » est préfixé au texte embeddé et stocké
   dans `heading_path`, que l'index plein texte couvre aussi.

### 1.4 Compter les tokens sans le tokenizer

Le chunker est une fonction pure du domaine : il tourne dans les tests unitaires et à
l'ingestion, avant tout chargement de modèle. Il ne peut donc pas appeler le vrai tokenizer
WordPiece. Il utilise une **estimation** : le texte est découpé en suites de lettres et de chiffres
et en symboles isolés ; un symbole compte 1, une suite compte 1 par tranche entamée de 7
caractères (ce qui imite le découpage des mots longs ou rares en sous-mots).

Calibrée sur les 2 749 lignes des guides contre le vrai tokenizer : ratio total estimé / réel de
**1,000**, erreur par ligne entre **−22 % (p5) et +21 % (p95)**. Les règles plus simples étaient
plus loin : caractères / 4 surestime de 8,5 % au total, mots × 1,3 sous-estime de 5,5 %
([`tokens.ts`](../../services/api/src/domain/rag/tokens.ts), docstring). Comme c'est une
estimation, les corps de chunks restent sous 450 tokens estimés : avec le fil d'Ariane, 2 chunks
sur 2 136 dépassent quand même les 512 tokens réels, et l'éval les compte.

### 1.5 Étiqueter par section, pas par chunk

Le dataset de récupération étiquette chaque requête avec des **sections**
(`destination, document, section`), jamais avec des ids de chunk : les ids changent dès qu'on
change le chunking, les sections restent. C'est ce qui permet de comparer deux chunkings sur les
mêmes étiquettes. Le chunker participe à ce contrat en exposant, pour chaque chunk, la liste
`sections` qu'il couvre. Le détail des métriques est dans le
[guide des métriques d'éval](eval-metrics.md).

### 1.6 Fusionner deux classements

| Option                                         | Principe                                                               | Pourquoi pas (ou pas encore)                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Vecteur seul                                   | Une seule liste                                                        | Le plus simple, et **aussi bon** sur ce dataset ; c'est le repli si un dataset relu ne montre aucun gain                            |
| Somme pondérée de scores normalisés            | `α · cos + (1 − α) · rank_lex`, après normalisation (min-max, z-score) | Deux échelles sans rapport, une normalisation par requête fragile, un poids α à régler                                              |
| CombSUM / CombMNZ                              | Sommes de scores normalisés, bonus aux documents présents partout      | Même problème de normalisation                                                                                                      |
| **RRF** (retenu)                               | `score(d) = Σ 1 / (k + rang)` sur les listes où d apparaît             | N'utilise que les rangs ; un seul paramètre avec une valeur standard ; fonction pure, testable sans base                            |
| Re-ranker _cross-encoder_ sur le top fusionné  | Un modèle relit (requête, passage) et reclasse                         | Plus précis mais un modèle de plus à chaque recherche ; roadmap, si l'éval montre que la bonne section est trouvée mais mal classée |
| Moteur dédié (Elasticsearch, Qdrant, Weaviate) | BM25, hybride intégré                                                  | Un service de plus à opérer et synchroniser pour quelques milliers de chunks                                                        |

**Comprendre `k`.** Avec `k = 60` (la valeur de l'article d'origine, Cormack, Clarke et Büttcher,
SIGIR 2009), le premier rang vaut 1/61 ≈ 0,0164, le deuxième 1/62 ≈ 0,0161, le dixième 1/70 ≈
0,0143 : les écarts entre rangs sont faibles, donc **être présent dans les deux listes compte plus
qu'être premier dans une seule** (deuxième partout : 2/62 ≈ 0,0323, contre 0,0164). Plus `k` est
petit, plus les premiers rangs dominent ; avec `k = 1`, être premier d'une liste (1/2) vaut autant
qu'être troisième dans deux (1/4 + 1/4).

**Ce que RRF ignore** : la confiance de chaque liste. Un excellent match vectoriel et un match
médiocre au même rang pèsent pareil.

**Le résultat honnête** ([ADR 0005](../adr/0005-hybrid-retrieval-with-rrf.md)) : l'hybride bat
largement le plein texte seul, mais **n'est pas prouvé meilleur que le vecteur seul** sur ce
dataset. Hybride « all words » (le défaut) moins vecteur : +0,9 point de Recall@5 (IC de 0,0 à
2,8) et 0,0 de MRR@10 (IC de −4,7 à 4,7). On le garde parce que sa liste lexicale est le mécanisme
qui sert les noms exacts, mais le dataset a peu de requêtes de ce type. Savoir dire « mon choix
n'est pas prouvé, et voici ce qui le trancherait » fait partie de la réponse.

**Le déterminisme.** Deux recherches identiques doivent rendre le même ordre. Avec des rangs
entiers, les égalités de score sont fréquentes : le tri doit donc être un ordre **total** et
stable. Un vrai bug de ce type a été trouvé dans le projet, côté plein texte : des ex aequo de
`ts_rank_cd` départagés par un UUID aléatoire, d'où deux runs d'éval différents (voir la Q18 de
[INTERVIEW_NOTES.md](../INTERVIEW_NOTES.md#7-questions-dentretien-et-réponses)).

## Partie 2 : lecture guidée de l'implémentation réelle

### 2.1 L'estimation de tokens

[`tokens.ts:21`](../../services/api/src/domain/rag/tokens.ts#L21). Deux expressions régulières
Unicode font tout le travail ([lignes 17 et 18](../../services/api/src/domain/rag/tokens.ts#L17)) :
`PIECE` capture soit une suite de lettres (`\p{L}`), de marques diacritiques (`\p{M}`, pour les
accents décomposés) et de chiffres (`\p{N}`), soit un caractère isolé qui n'est ni un espace ni
l'un des précédents. `WORD_RUN` dit si un morceau est une suite. Le drapeau `u` est
indispensable : sans lui, `\p{…}` n'existe pas, et un « é » ou un caractère grec serait compté
comme un symbole. `Math.ceil(longueur / 7)` ([ligne 25](../../services/api/src/domain/rag/tokens.ts#L25))
compte les tranches **entamées**.

### 2.2 Le chunker

[`chunker.ts`](../../services/api/src/domain/rag/chunker.ts). Le docstring en tête (lignes 3 à 19) est le résumé à savoir réciter.

**Le vocabulaire.** Un `Block` est un paragraphe, un élément de liste, une citation ou un bloc de
code, avec son estimation de tokens ([ligne 77](../../services/api/src/domain/rag/chunker.ts#L77)) ;
une `Section` est un chemin de titres et ses blocs ; une `Unit` est une section ou plusieurs
petites sections sœurs fusionnées ([ligne 89](../../services/api/src/domain/rag/chunker.ts#L89)) ;
une `Part` est un morceau d'unité, avec le nombre de blocs de tête qui viennent du chevauchement
([ligne 96](../../services/api/src/domain/rag/chunker.ts#L96)).

**Les options et leurs invariants.** `validateChunkingOptions`
([ligne 103](../../services/api/src/domain/rag/chunker.ts#L103)) impose des entiers positifs et
`min ≤ target ≤ max`, `overlap < target`. Sans `overlap < target`, une partie pourrait ne contenir
que du chevauchement. `chunkingFingerprint` ([ligne 119](../../services/api/src/domain/rag/chunker.ts#L119))
décrit la configuration (`md-v1;target=300;max=450;overlap=30;min=60;header=on`) : elle est stockée
avec chaque document indexé, et l'ingestion ne re-découpe un document que si son contenu, le
modèle ou cette empreinte change ([`ingest-corpus.ts:70`](../../services/api/src/application/ingest-corpus.ts#L70)).
`CHUNKER_VERSION` ([ligne 35](../../services/api/src/domain/rag/chunker.ts#L35)) est à incrémenter
quand l'algorithme change, pour forcer une ré-ingestion.

**Le pipeline**, `chunkMarkdown` ([ligne 149](../../services/api/src/domain/rag/chunker.ts#L149)) :
valider, découper en sections, transformer en unités, fusionner les petites, découper chaque unité
en parties, et fabriquer un chunk par partie : `ordinal`, `headingPath` (titre du document + chemin
de l'unité, [ligne 165](../../services/api/src/domain/rag/chunker.ts#L165)), `sections` (chemins
relatifs au document, `""` pour le texte avant tout titre), `content` (sans fil d'Ariane, c'est ce
que voit l'agent), `text` (avec fil d'Ariane si l'option est active, c'est ce qu'on embedde,
[ligne 167](../../services/api/src/domain/rag/chunker.ts#L167)) et `tokenCount`.

**Les sections**, `parseSections` ([ligne 190](../../services/api/src/domain/rag/chunker.ts#L190)) :
un parcours ligne par ligne avec un tampon. Les fins de ligne Windows sont normalisées d'abord
([ligne 191](../../services/api/src/domain/rag/chunker.ts#L191)). Un état « dans un bloc de code »
empêche un `## …` de code d'être pris pour un titre ([ligne 206](../../services/api/src/domain/rag/chunker.ts#L206)).
Les titres de niveau 4 ou plus, et les titres vides, restent dans le tampon
([ligne 211](../../services/api/src/domain/rag/chunker.ts#L211)). Un `# Titre` tout au début est le
titre du document, déjà racine du fil d'Ariane : on l'ignore ([ligne 213](../../services/api/src/domain/rag/chunker.ts#L213)).
Un `#` ou `##` ouvre une section de premier niveau et devient le `##` courant ; un `###` donne le
chemin `[## courant, titre]`, ou `[titre]` s'il n'y a pas encore eu de `##`
([lignes 215 à 222](../../services/api/src/domain/rag/chunker.ts#L215)). Vider le tampon ne crée
une section que si elle a des blocs ([ligne 200](../../services/api/src/domain/rag/chunker.ts#L200)) :
un titre qui ne fait qu'introduire des sous-sections ne donne pas de chunk vide.

**Les blocs**, `toBlocks` ([ligne 233](../../services/api/src/domain/rag/chunker.ts#L233)) : le
seul endroit qui connaît la syntaxe Markdown ligne à ligne. Un élément de liste de premier niveau
ouvre un bloc ; ses lignes de suite et ses sous-éléments (indentés) s'y ajoutent, parce qu'une
ligne qui n'est ni un élément de premier niveau ni une citation est un `paragraph` qui « continue »
le bloc courant ([ligne 273](../../services/api/src/domain/rag/chunker.ts#L273)). Une citation ne
continue qu'une citation. Un titre interne est collé au bloc qui le suit
([lignes 284 à 301](../../services/api/src/domain/rag/chunker.ts#L284)) : jamais un titre seul en
fin de partie.

**La fusion**, `mergeSmallSiblings` ([ligne 328](../../services/api/src/domain/rag/chunker.ts#L328)) :
un seul passage, en comparant chaque unité à la **dernière unité gardée** (donc au résultat de la
fusion précédente, ce qui permet d'enchaîner A + B + C). Condition : l'une des deux est petite,
elles sont sœurs, et la fusion tient dans la cible ([ligne 339](../../services/api/src/domain/rag/chunker.ts#L339)).
`areSiblings` ([ligne 321](../../services/api/src/domain/rag/chunker.ts#L321)) regarde **toutes**
les sections couvertes : même `##` pour toutes (une introduction et ses `###`), ou toutes de
premier niveau (des `##` sans sous-sections, qui fusionnent alors sous la racine). Jamais à travers
deux `##` différents. `mergeUnits` ([ligne 349](../../services/api/src/domain/rag/chunker.ts#L349))
prend le préfixe commun des chemins comme nouveau chemin, et `withHeading`
([ligne 361](../../services/api/src/domain/rag/chunker.ts#L361)) recrée en Markdown les titres
perdus, au bon niveau (profondeur + 2), collés au premier bloc : « Fishing » sous « Do » redevient
`### Fishing` dans le contenu, pour que le lecteur (et l'embedding) sache encore de quoi parle
chaque morceau.

**La découpe**, `splitUnit` ([ligne 385](../../services/api/src/domain/rag/chunker.ts#L385)) :

1. une unité qui tient dans `maxTokens` reste entière ([ligne 386](../../services/api/src/domain/rag/chunker.ts#L386)) ;
   la cible ne sert qu'à découper, la fenêtre entre cible et maximum évite de couper une section
   de 320 tokens en 300 + 20 ;
2. les paragraphes et citations plus longs que le maximum sont d'abord coupés entre phrases vers
   la cible ([ligne 390](../../services/api/src/domain/rag/chunker.ts#L390)) ; **pas les éléments
   de liste** ;
3. un remplissage glouton vers la cible ([lignes 401 à 412](../../services/api/src/domain/rag/chunker.ts#L401)) :
   on ferme la partie quand le bloc suivant ferait dépasser la cible **et** que la partie contient
   au moins un bloc neuf (`hasFreshBlocks`, [ligne 402](../../services/api/src/domain/rag/chunker.ts#L402)).
   Sans cette garde, une partie ne contenant que du chevauchement serait fermée, puis rouverte avec
   le même chevauchement : on n'avancerait plus ;
4. la partie suivante commence par le chevauchement, **sauf** s'il ferait dépasser le maximum avec
   le bloc à venir ([ligne 406](../../services/api/src/domain/rag/chunker.ts#L406)) : le maximum
   gagne sur le chevauchement ;
5. `absorbSmallTail` ([ligne 419](../../services/api/src/domain/rag/chunker.ts#L419)) replie une
   dernière partie minuscule dans l'avant-dernière, **sans son chevauchement** (déjà présent dans
   l'avant-dernière), si le tout tient dans le maximum.

**Le chevauchement**, `overlapFrom` ([ligne 433](../../services/api/src/domain/rag/chunker.ts#L433)) :
des blocs **entiers** pris depuis la fin tant qu'ils tiennent dans le budget ; si le tout dernier
bloc est un paragraphe trop long, ses dernières phrases (`trailingSentences`,
[ligne 462](../../services/api/src/domain/rag/chunker.ts#L462)). Jamais un morceau de fiche.

**Les phrases**, `splitSentences` ([ligne 455](../../services/api/src/domain/rag/chunker.ts#L455)) :
une coupure après `.`, `!`, `?` ou `…`, suivie d'espaces puis d'une majuscule ou d'un chiffre
(éventuellement après un guillemet ou une parenthèse), grâce à un _lookbehind_ et un _lookahead_
qui ne consomment que les espaces ([ligne 453](../../services/api/src/domain/rag/chunker.ts#L453)).
« 3 buses run. done » ne coupe pas : minuscule après le point. Ce n'est pas un vrai découpeur de
phrases (« Mt. Etna » coupe à tort), c'est un compromis assumé pour un corpus touristique.
`splitParagraph` ([ligne 477](../../services/api/src/domain/rag/chunker.ts#L477)) remplit des
morceaux de phrases vers la cible ; un morceau n'est jamais vide, donc une phrase énorme forme un
morceau à elle seule.

**L'assemblage**, `joinBlocks` ([ligne 508](../../services/api/src/domain/rag/chunker.ts#L508)) :
deux éléments de liste consécutifs sont séparés par un saut de ligne (la liste reste une liste),
les autres blocs par une ligne vide.

### 2.3 La fusion RRF

[`rrf.ts:30`](../../services/api/src/domain/rag/rrf.ts#L30), `reciprocalRankFusion`, générique
sur les noms de listes (`'vector' | 'fullText'` en production) :

1. validation de `k` (fini, strictement positif) et de `limit` (entier ≥ 0)
   ([lignes 34 à 39](../../services/api/src/domain/rag/rrf.ts#L34)) ;
2. pour chaque liste, dans l'ordre des clés, chaque id reçoit son rang 1-based ; un id répété
   dans une même liste garde son **premier** rang ([ligne 54](../../services/api/src/domain/rag/rrf.ts#L54)) ;
   les listes où il est absent gardent `null` ;
3. le score est sommé **dans l'ordre des listes** ([lignes 58 à 66](../../services/api/src/domain/rag/rrf.ts#L58)) :
   l'addition flottante n'est pas associative, et l'ordre d'une `Map` dépend de l'ordre
   d'insertion ; sommer toujours dans le même ordre rend le score indépendant de l'ordre d'arrivée
   des ids ;
4. tri par `compare` ([ligne 72](../../services/api/src/domain/rag/rrf.ts#L72)) : score
   décroissant, puis meilleur rang (le plus petit toutes listes confondues), puis rang dans la
   première liste, la deuxième, etc. Deux ids distincts n'ont jamais le même rang dans une même
   liste, donc ce dernier critère décide toujours : l'ordre est total ;
5. `limit` appliqué **après** la fusion ([ligne 69](../../services/api/src/domain/rag/rrf.ts#L69)).

Le résultat garde les rangs de chaque liste (`ranks`) : c'est ce qui permet de diagnostiquer une
mauvaise récupération (« trouvé par le vecteur au rang 2, absent du plein texte »). Le score
fusionné et les rangs de chaque extrait sont dans la trace de l'appel `search_knowledge` (sa vue de
trace, `traceOutput`), mais pas dans ce que reçoit le modèle : ils ne lui servent à rien et
coûteraient des tokens.

### 2.4 Où ces modules servent

- **Ingestion** : [`ingest-corpus.ts:95`](../../services/api/src/application/ingest-corpus.ts#L95)
  découpe chaque document avec le titre du document comme racine du fil d'Ariane.
- **Recherche** : [`pg-retriever.ts`](../../services/api/src/infrastructure/knowledge/pg-retriever.ts)
  prend 20 candidats par liste ([ligne 43](../../services/api/src/infrastructure/knowledge/pg-retriever.ts#L43),
  au moins la limite demandée, [ligne 105](../../services/api/src/infrastructure/knowledge/pg-retriever.ts#L105)),
  une liste vectorielle (distance cosinus `<=>` sur l'index HNSW) et une liste plein texte
  (`websearch_to_tsquery('english')`, classée par `ts_rank_cd`, ex aequo départagés par chemin de
  document puis position, [ligne 187](../../services/api/src/infrastructure/knowledge/pg-retriever.ts#L187)),
  les fusionne ([ligne 128](../../services/api/src/infrastructure/knowledge/pg-retriever.ts#L128)),
  puis relit les chunks retenus, le tout dans une transaction `REPEATABLE READ, READ ONLY` pour
  qu'une ré-ingestion concurrente ne retire pas un chunk entre les deux listes.
- **Éval** : `evals/runner/fixed-size-chunker.ts` est la baseline à fenêtres fixes ;
  `evals/runner/in-memory-knowledge.ts` utilise le vrai chunker pour les contrôles sans clé.

### 2.5 Les cas limites à connaître

| Situation                                           | Comportement                                      | Où                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Document vide ou qui n'a que des titres             | Aucun chunk                                       | [`chunker.ts:200`](../../services/api/src/domain/rag/chunker.ts#L200)                                                                        |
| Texte avant le premier titre                        | Un chunk sous la racine, section `""`             | [`chunker.ts:190`](../../services/api/src/domain/rag/chunker.ts#L190)                                                                        |
| `###` avant tout `##`                               | Section de premier niveau                         | [`chunker.ts:221`](../../services/api/src/domain/rag/chunker.ts#L221)                                                                        |
| `##` dans un bloc de code                           | Pas un titre ; le bloc de code n'est jamais coupé | [`chunker.ts:206`](../../services/api/src/domain/rag/chunker.ts#L206)                                                                        |
| Fiche (élément de liste) plus longue que le maximum | Seule dans son chunk, entière                     | [`chunker.ts:391`](../../services/api/src/domain/rag/chunker.ts#L391)                                                                        |
| Chevauchement + bloc suivant > maximum              | Le chevauchement est abandonné                    | [`chunker.ts:406`](../../services/api/src/domain/rag/chunker.ts#L406)                                                                        |
| Petite queue                                        | Repliée dans la partie précédente si ça tient     | [`chunker.ts:419`](../../services/api/src/domain/rag/chunker.ts#L419)                                                                        |
| `minTokens = 0` / `overlapTokens = 0`               | Aucune fusion / aucun chevauchement               | [`chunker.ts:336`](../../services/api/src/domain/rag/chunker.ts#L336), [`chunker.ts:434`](../../services/api/src/domain/rag/chunker.ts#L434) |
| Id répété dans une liste RRF                        | Premier rang seulement, compté une fois           | [`rrf.ts:54`](../../services/api/src/domain/rag/rrf.ts#L54)                                                                                  |
| Égalité de score RRF                                | Meilleur rang, puis rang dans la première liste   | [`rrf.ts:72`](../../services/api/src/domain/rag/rrf.ts#L72)                                                                                  |
| Listes vides, aucune liste                          | Résultat vide                                     | [`rrf.ts:30`](../../services/api/src/domain/rag/rrf.ts#L30)                                                                                  |

### 2.6 Pourquoi chaque test existe

Les tests du chunker utilisent un estimateur « un mot = un token »
([`chunker.test.ts:12`](../../services/api/src/domain/rag/chunker.test.ts#L12)) et des options
minuscules (cible 40, maximum 60, minimum 10, [ligne 14](../../services/api/src/domain/rag/chunker.test.ts#L14)) :
les budgets se calculent de tête, et l'algorithme est testé indépendamment de l'estimation.
`lorem(n)` produit n mots distincts, `items(n, size)` n fiches de `size` mots.

**`tokens.test.ts`** : un mot court et un symbole valent 1
([ligne 5](../../services/api/src/domain/rag/tokens.test.ts#L5), « €50-80 (per night) » fait 8) ;
un mot long vaut plusieurs sous-mots ([ligne 10](../../services/api/src/domain/rag/tokens.test.ts#L10)) ;
accents, grec et texte vide ([ligne 15](../../services/api/src/domain/rag/tokens.test.ts#L15)) :
le corpus contient des noms locaux, et l'estimation ne doit pas les compter lettre par lettre.

**`rrf.test.ts`**

| Test                                                                                                           | Ce qu'il protège                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [sums 1 / (k + rank)…](../../services/api/src/domain/rag/rrf.test.ts#L5)                                       | La formule, et l'absence d'une liste qui ne contribue pas                      |
| [keeps the 1-based rank of each list, null when absent](../../services/api/src/domain/rag/rrf.test.ts#L15)     | Les rangs gardés pour le diagnostic (et les traces)                            |
| [uses k = 60 by default and accepts another k](../../services/api/src/domain/rag/rrf.test.ts#L25)              | La valeur standard, et le paramètre                                            |
| [rewards agreement between lists over a single first place](../../services/api/src/domain/rag/rrf.test.ts#L31) | La propriété qui justifie la fusion                                            |
| [breaks a score tie in favour of the better best rank](../../services/api/src/domain/rag/rrf.test.ts#L40)      | Le deuxième critère du tri                                                     |
| [breaks a remaining tie by the rank in the earliest list](../../services/api/src/domain/rag/rrf.test.ts#L48)   | Le dernier critère : un ordre total                                            |
| [is deterministic whatever the insertion order of the ids](../../services/api/src/domain/rag/rrf.test.ts#L56)  | Le même ordre et **le même score au bit près**                                 |
| [keeps the best rank of an id repeated inside a list](../../services/api/src/domain/rag/rrf.test.ts#L65)       | Pas de double comptage                                                         |
| [applies the limit after fusion and handles empty input](../../services/api/src/domain/rag/rrf.test.ts#L71)    | Couper avant de fusionner perdrait les documents présents dans les deux listes |
| [rejects k = …, rejects limit = …](../../services/api/src/domain/rag/rrf.test.ts#L77)                          | Pas de division par zéro ni de score infini ou `NaN` silencieux                |

**`chunker.test.ts`, une section = un chunk**
([lignes 29 à 127](../../services/api/src/domain/rag/chunker.test.ts#L29)) : fil d'Ariane depuis le
titre du document, en-tête contextuel seulement si l'option est active (et compté dans
`tokenCount`), texte avant le premier titre, titres qui n'introduisent que des sous-sections,
`####` collés à leur bloc, `###` orphelin et `#` tardif, blocs de code, document vide, fins de ligne
Windows et titres fermés par des `#`. Chacun correspond à une forme réelle des guides Wikivoyage
convertis.

**Fusion** ([lignes 129 à 198](../../services/api/src/domain/rag/chunker.test.ts#L129)) : une petite
section rejoint sa sœur **avec son titre dans le contenu** ; une introduction rejoint sa première
sous-section ; des `##` sans sous-section fusionnent sous la racine ; jamais à travers deux `##` ;
pas au-delà de la cible ; enchaînement de petites sœurs ; `minTokens = 0` désactive la fusion.

**Découpe** ([lignes 200 à 322](../../services/api/src/domain/rag/chunker.test.ts#L200)) : une
section entière jusqu'au maximum ; une liste coupée entre fiches et reconstituable à l'identique ;
une fiche trop longue seule et entière ; un paragraphe coupé entre phrases ; le chevauchement en
blocs entiers, puis en dernières phrases ; le chevauchement abandonné quand il ferait dépasser ;
la queue repliée, gardée séparée si le repli dépasserait, et repliée sans dupliquer le
chevauchement ; les lignes de suite d'une fiche ; citations et paragraphes séparés.

**Le reste** : l'estimateur par défaut branché ([ligne 324](../../services/api/src/domain/rag/chunker.test.ts#L324)),
la validation des options **y compris par `chunkMarkdown`** ([ligne 335](../../services/api/src/domain/rag/chunker.test.ts#L335)),
la fabrique qui valide une seule fois ([ligne 355](../../services/api/src/domain/rag/chunker.test.ts#L355)),
l'empreinte ([ligne 379](../../services/api/src/domain/rag/chunker.test.ts#L379)) et les phrases
([ligne 386](../../services/api/src/domain/rag/chunker.test.ts#L386)).

## Partie 3 : l'exercice, étape par étape

Sur la branche `learning/chunking-rrf` (voir [`docs/LEARNING.md`](../LEARNING.md)). Le
`LEARNING.md` à la racine de la branche donne la commande de chaque étape. Ne lis l'indice suivant
qu'après avoir vraiment essayé.

### Étape 1 : l'estimation de tokens (3 tests)

`tokens.ts`. Les deux regex d'origine ont été retirées.

- **Indice 1.** Un morceau est soit une suite de « caractères de mot », soit un caractère isolé
  qui n'est ni un espace ni un caractère de mot. Les espaces ne produisent aucun morceau.
- **Indice 2.** Les classes Unicode utiles sont les lettres, les marques et les chiffres. Une
  seule regex globale avec une alternative, parcourue avec `matchAll`.
- **Indice 3.** Pour savoir si un morceau est une suite, teste son premier caractère avec une
  seconde regex (sans le drapeau `g`, qui rendrait `test` dépendant de `lastIndex`).

### Étape 2 : la fusion RRF (15 tests)

`rrf.ts`.

- **Indice 1.** Deux phases : collecter les rangs de chaque id dans chaque liste (une `Map` id →
  rangs), puis calculer les scores et trier.
- **Indice 2.** Initialise les rangs d'un id à `null` pour **toutes** les listes la première fois
  que tu le vois ; n'écris un rang que s'il est encore `null` (id répété).
- **Indice 3.** Pour `compare`, renvoie dès qu'un critère départage ; un rang absent vaut
  `Number.POSITIVE_INFINITY` dans les comparaisons. Le test des égalités avec `k = 1` se vérifie à
  la main : fais le calcul sur papier avant de déboguer.

Piège : `Number.isFinite(NaN)` est faux, mais `NaN <= 0` aussi. Teste la finitude **et** le signe.

### Étape 3 : une section = un chunk (17 tests)

`parseSections` et une première version de `chunkMarkdown` qui ne fusionne ni ne découpe (une
unité = une partie). `toBlocks` est fourni.

- **Indice 1.** Écris `chunkMarkdown` d'abord, en supposant `parseSections` correct : c'est un
  `map` des sections vers des chunks. Puis `parseSections`.
- **Indice 2.** Dans `parseSections`, la fonction locale « vider le tampon » appelle `toBlocks`, ne
  pousse une section que si elle a des blocs, et réinitialise le tampon. Garde deux variables : le
  chemin courant et le titre `##` courant.
- **Indice 3.** Le titre du document n'est ignoré que s'il est de niveau 1, que c'est le premier
  titre vu, qu'aucune section n'existe encore et que le tampon ne contient que des lignes vides.
  Pour un `###`, le chemin dépend de l'existence d'un `##` courant.

Les tests de `validateChunkingOptions` passent dès que `chunkMarkdown` valide ses options avant
tout le reste.

### Étape 4 : la fusion des petites sections (7 tests)

`areSiblings`, `mergeSmallSiblings`, `mergeUnits`, `withHeading`, puis branche la fusion dans
`chunkMarkdown`.

- **Indice 1.** Le résultat est une liste que tu construis en regardant toujours son **dernier**
  élément : remplace-le par la fusion quand elle est acceptée, sinon pousse l'unité.
- **Indice 2.** `withHeading` ne fait rien quand le chemin de l'unité n'est pas plus long que le
  chemin commun. Sinon, les titres à recréer sont les éléments du chemin **au-delà** du préfixe
  commun, au niveau `profondeur + 2` (`##` sous la racine, `###` sous un `##`).
- **Indice 3.** Le contenu attendu par le test « merges a small section into its next sibling »
  montre la forme exacte : le titre, un saut de ligne, puis le texte du premier bloc.

### Étape 5 : les phrases (2 tests)

`splitSentences`. La regex `SENTENCE_BOUNDARY` est fournie.

- **Indice 1.** `String.prototype.split` accepte une regex.
- **Indice 2.** Nettoie chaque morceau et retire les vides.
- **Indice 3.** Le texte « done » final reste attaché à la phrase précédente : c'est voulu (pas
  de majuscule après le point).

### Étape 6 : la découpe des longues sections (12 tests)

`splitUnit`, `absorbSmallTail`, `overlapFrom`, `trailingSentences`, `splitParagraph`, puis
branche la découpe dans `chunkMarkdown`. Quelques tests du groupe passent déjà (ceux qui ne
demandent aucune découpe).

- **Indice 1.** Commence sans chevauchement : remplissage glouton vers la cible, une partie fermée
  quand le bloc suivant ferait dépasser. Fais passer « splits a long list between items » et
  « keeps an over-long list item whole ». Ajoute ensuite `splitParagraph` pour les paragraphes plus
  longs que le **maximum**.
- **Indice 2.** Pour le chevauchement, chaque partie retient combien de ses blocs de tête viennent
  de la partie précédente. On ne ferme une partie que si elle contient au moins un bloc neuf. Et
  le chevauchement est abandonné si chevauchement + bloc courant dépasse le maximum.
- **Indice 3.** `absorbSmallTail` : les blocs neufs de la dernière partie sont
  `blocks.slice(overlap)`. Le nouvel objet `Part` garde le chevauchement de l'**avant-dernière**.
  `overlapFrom` et `trailingSentences` parcourent depuis la fin et insèrent en tête (`unshift`)
  pour garder l'ordre.

Piège : comparer à la cible pour décider de **découper** une unité. C'est le maximum qui décide si
une unité est découpée ; la cible ne sert qu'à dimensionner les parties.

Quand les 56 tests passent, lance aussi `npx vitest run ingest-corpus` (depuis `services/api`) et
`npx vitest run agent-harness runner-parts` (depuis `evals`).

## Partie 4 : questions d'entretien sur ce sujet

**1. Comment avez-vous découpé votre corpus, et comment savez-vous que c'est un bon choix ?**

Un chunk par section `##`/`###` du Markdown ; les petites sections sœurs sont fusionnées, les
longues coupées entre paragraphes ou fiches avec un léger chevauchement, une fiche n'est jamais
coupée, et chaque chunk est préfixé par son fil d'Ariane avant l'embedding. Validé par l'éval de
récupération contre une baseline à fenêtres fixes : +10,4 points de Recall@5 (IC 95 % de 2,8 à
18,9) en recherche vectorielle, différence appariée sur 53 requêtes. Limite assumée : les tailles
elles-mêmes n'ont pas été balayées, et les requêtes ont été écrites par l'agent de build, en
attente de relecture humaine.

**2. Qu'est-ce qu'un _contextual chunk header_, et que coûte-t-il ?**

Le chemin de titres (« Sicily > Do > Skiing ») ajouté au texte embeddé. Un chunk comme « 2 small
ski stations » devient trouvable par « skiing in Sicily ». Il est aussi dans `heading_path`, que
l'index plein texte couvre. Le coût : quelques tokens de la fenêtre de 512, et un chunk dont le
fil d'Ariane domine l'embedding s'il est très court, d'où la fusion des petites sections.

**3. Pourquoi ne jamais couper un élément de liste ?**

Sur Wikivoyage, un élément de liste est une fiche : un nom, une description, un prix, des
horaires. Couper au milieu sépare le nom de son prix, et le morceau sans nom ne sert à rien. Le
chunker accepte donc qu'une fiche très longue dépasse le maximum, seule dans son chunk. C'est un
choix guidé par le corpus, pas une règle générale.

**4. À quoi sert le chevauchement, et pourquoi en blocs entiers ?**

À ne pas perdre le contexte à la frontière : une question dont la réponse est à cheval sur deux
parties trouve l'une ou l'autre avec ce qui précède. En blocs entiers (ou en dernières phrases
d'un paragraphe) pour ne jamais reprendre un demi-paragraphe ou une demi-fiche. Il est petit (30
tokens) parce qu'il duplique du texte dans l'index et dans le contexte de l'agent, et il saute
quand il ferait dépasser le maximum.

**5. Pourquoi estimer les tokens au lieu d'utiliser le tokenizer ?**

Le chunker est une fonction pure du domaine : il tourne en tests et à l'ingestion sans charger le
modèle. L'estimation (suites de lettres par tranches de 7 caractères, symboles à 1) a été
calibrée contre le vrai tokenizer : ratio total 1,000, erreur par ligne de −22 % à +21 % (p5 à
p95), mieux que caractères / 4 ou mots × 1,3. Comme c'est une estimation, on garde de la marge
(450 tokens estimés pour une fenêtre de 512), et l'éval compte les chunks qui dépassent quand même
(2 sur 2 136).

**6. Expliquez RRF. Pourquoi pas une somme pondérée des scores ?**

Chaque document reçoit `Σ 1 / (k + rang)` sur les listes où il apparaît, avec `k = 60`. Seuls les
rangs comptent : une distance cosinus et un `ts_rank_cd` ne sont pas sur la même échelle, et une
somme pondérée demanderait de normaliser par requête (min-max ou z-score, sensibles aux valeurs
extrêmes) et de régler un poids. RRF a un paramètre, avec une valeur standard, et c'est une
fonction pure testable sans base. Son défaut : il ignore la confiance de chaque liste.

**7. Que change `k` ?**

Il amortit l'avantage des premiers rangs. Avec 60, rang 1 et rang 2 valent presque pareil (1/61
contre 1/62), donc être présent dans les deux listes l'emporte sur être premier dans une seule.
Avec un `k` petit, les premiers rangs dominent. Je n'ai pas réglé `k` : 60 est la valeur de
l'article d'origine, et je n'ai pas de dataset assez grand pour distinguer deux valeurs proches.

**8. L'hybride est-il meilleur que le vecteur seul ?**

Pas sur ce dataset. Il bat largement le plein texte seul, mais face au vecteur seul les
différences ne sont pas établies (hybride par défaut moins vecteur : +0,9 point de Recall@5,
IC de 0,0 à 2,8 ; 0,0 de MRR@10). Je le garde parce que la liste lexicale est le mécanisme qui sert
les noms exacts, que le dataset contient peu ; si un dataset relu par un humain ne montre toujours
rien, le vecteur seul est le choix le plus simple.

**9. Pourquoi tant d'efforts sur l'ordre des égalités ?**

Parce qu'une éval n'a de sens que si deux runs identiques donnent le même résultat. Avec des rangs
entiers, les égalités de score RRF sont fréquentes ; un `sort` sur le seul score laisserait l'ordre
dépendre de l'ordre d'arrivée des ids. On départage par meilleur rang puis par rang dans la
première liste : un ordre total. Le projet a eu le bug côté SQL : des ex aequo de `ts_rank_cd`
départagés par un UUID aléatoire, recréé à chaque ingestion ; deux runs d'éval différaient. Leçon :
comparer deux runs censés être identiques teste la mesure elle-même.

**10. Pourquoi 20 candidats par liste alors que l'agent en demande 5 ?**

La fusion a besoin de profondeur : un passage au rang 12 en vectoriel et au rang 3 en plein texte
doit pouvoir remonter, et il disparaîtrait si chaque liste était coupée à 5. La limite est donc
appliquée **après** la fusion. 20 reste bon marché (deux requêtes indexées) ; je n'ai pas mesuré
d'autre valeur.

**11. Que se passe-t-il quand vous changez les paramètres du chunker ?**

L'empreinte change (`md-v1;target=…`), l'ingestion re-découpe et ré-embedde les documents
concernés, les autres sont sautés grâce au checksum. Les étiquettes de l'éval nomment des
sections, pas des chunks : elles restent valides, et on peut comparer l'ancien et le nouveau
chunking sur les mêmes requêtes. Si l'algorithme change, on incrémente `CHUNKER_VERSION`.

**12. Que feriez-vous ensuite pour améliorer la récupération ?**

Dans l'ordre, guidé par les données : faire relire et compléter le dataset par un humain (avec
plus de requêtes de noms exacts, pour enfin trancher l'hybride) ; balayer les tailles de chunk ;
regarder les requêtes ratées pour savoir si la bonne section est trouvée mais mal classée (alors
un _cross-encoder_ sur le top 20 fusionné) ou pas trouvée du tout (chunking, requête, modèle
d'embedding) ; BM25 (`pg_search`) si le classement lexical devient le goulot.

## Partie 5 : grille d'auto-relecture

```sh
git diff main -- services/api/src/domain/rag/tokens.ts
git diff main -- services/api/src/domain/rag/rrf.ts
git diff main -- services/api/src/domain/rag/chunker.ts
```

Si `main` a bougé depuis la création de la branche : `git diff $(git merge-base main HEAD) -- <fichier>`.

- [ ] Les lignes `eslint-disable … learning skeleton` et tous les `TODO(learning)` ont disparu ;
      `npx eslint` et `npx prettier --check` passent sur les trois fichiers.
- [ ] `npm test` et `npm run typecheck` passent à la racine, y compris l'ingestion et les runners
      d'éval.
- [ ] Ta regex de tokens a le drapeau `u`, compte les lettres accentuées et non latines comme des
      lettres, et ne crée aucun morceau pour les espaces.
- [ ] RRF : `k` invalide (0, négatif, `NaN`, infini) et `limit` invalide lèvent une `RangeError`.
- [ ] RRF : le score est sommé dans l'ordre des listes ; le tri est total ; `limit` est appliqué
      après la fusion.
- [ ] Le chunker est pur : pas d'I/O, pas d'état global, pas de mutation des entrées (les blocs
      d'une unité ne sont jamais modifiés en place).
- [ ] Une fiche n'est jamais coupée ; seul un paragraphe (ou une citation) plus long que le
      **maximum** est coupé entre phrases.
- [ ] Une partie n'est fermée que si elle contient un bloc neuf ; le chevauchement saute quand il
      ferait dépasser le maximum ; la queue est repliée sans son chevauchement.
- [ ] La fusion ne traverse jamais deux `##` différents et ne dépasse jamais la cible.
- [ ] Pas de boucle sans progrès possible : chaque itération consomme au moins un bloc ou une
      phrase.
- [ ] Pour chaque différence avec l'original, tu sais dire si ta version est équivalente, meilleure
      ou moins bonne, et pourquoi.
