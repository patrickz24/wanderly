# ADR 0005: Hybrid retrieval with Reciprocal Rank Fusion in Postgres

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 2

## Context

Travel queries mix two kinds of need: exact names that a small embedding model represents poorly
("Benagil", "GR 20", "Bar to Bari ferry"), and paraphrases that share no word with the guide
("walks along old irrigation channels" for Madeira's levadas). Vector search handles the second,
lexical search the first. Their scores live on different scales (cosine distance against
`ts_rank_cd`), so a weighted sum would need a fragile normalization. Everything already lives in
Postgres (pgvector, full-text search), and the plan asked for the choice to be justified by
measured numbers.

## Decision

`PgRetriever` (`services/api/src/infrastructure/knowledge/pg-retriever.ts`) runs two top-20 lists
and fuses them with **Reciprocal Rank Fusion** (`score = Σ 1 / (60 + rank)`), a pure domain
function (`domain/rag/rrf.ts`) that keeps each chunk's rank in each list for diagnostics and
breaks ties deterministically.

- **Vector:** cosine distance `<=>` on an HNSW index (`vector_cosine_ops`).
- **Full text:** `websearch_to_tsquery('english')` on a generated `tsvector` of the breadcrumb and
  the content, ranked by `ts_rank_cd`. The default mode is `websearch_to_tsquery` as is (**all words** must match); an **any word**
  mode (words joined with the websearch `or` operator) exists and is measured below.
- **Destination filter:** with a filter, the HNSW scan uses pgvector's iterative index scan
  (`hnsw.iterative_scan = strict_order`, `ef_search` 100). A plain filtered HNSW query takes the
  nearest neighbours of all destinations first and filters afterwards, so it can silently return
  fewer chunks than asked; an integration test covers this case.
- Both lists and the final read run in one `REPEATABLE READ, READ ONLY` transaction, so a
  concurrent re-ingestion cannot remove a chunk between them. All SQL is parameterized.
- A `strategy` option (`hybrid` | `vector` | `fulltext`) exists for the evaluation; production
  uses `hybrid`.

Measured with the retrieval evaluation (53 queries, labels pending human review; full table and
method in [EVALUATIONS.md](../EVALUATIONS.md#results)):

| Strategy (structure-aware chunks) | Recall@5 | Recall@10 | MRR@10 | Hit@1 | Hit@5 | p50 latency |
| --------------------------------- | -------: | --------: | -----: | ----: | ----: | ----------: |
| vector                            |     79.2 |      82.1 |   75.0 |  67.9 |  81.1 |       13 ms |
| full text, all words              |     23.6 |      23.6 |   26.4 |  26.4 |  26.4 |       10 ms |
| full text, any word               |     59.7 |      78.6 |   51.6 |  39.6 |  64.2 |       12 ms |
| **hybrid, all words (default)**   |     80.2 |      83.0 |   75.0 |  66.0 |  83.0 |       16 ms |
| hybrid, any word                  |     81.1 |      85.2 |   69.7 |  58.5 |  84.9 |       18 ms |

What the numbers support, and what they do not:

- Full text alone is weak on this dataset, and requiring every word makes it unusable for
  questions (23.6 Recall@5); "any word" gains 36.2 points of Recall@5 (95 % CI 22.6 to 50.0).
- **Hybrid is not measurably better than vector alone here.** Hybrid (all words) minus vector:
  +0.9 point of Recall@5 (95 % CI 0.0 to 2.8), +1.9 of Hit@5 (0.0 to 5.7), 0.0 of MRR@10
  (-4.7 to 4.7), -1.9 of Hit@1 (-9.4 to 5.7, one query).
- Fusing the "any word" list instead adds 0.9 point of Recall@5 (CI -4.7 to 6.6) but costs 5.3
  points of MRR@10 (CI -12.9 to 2.2). Neither difference is established, so the default keeps the
  list that does not lower the ranking.

We keep hybrid (all words) as the default: on this dataset it is at least as good as vector search
on every averaged metric but Hit@1, for about 3 ms more at the median, and its lexical list is the
mechanism that can serve exact names that a small embedding model represents poorly. The dataset
does not prove that benefit: its labels are agent-proposed and it has few name-only queries. If a
human-reviewed dataset still shows no gain, vector-only is the simpler choice.

## Consequences

### Positive

- One database, no extra search service; rank fusion needs no score calibration.
- Paraphrases and exact names each have a list that can find them, and each result carries its rank in both lists,
  which makes a bad retrieval easy to diagnose (traces show `ranks.vector` / `ranks.fullText`).

### Negative

- Two queries per search instead of one, plus the query embedding.
- `ts_rank_cd` is not BM25 (no inverse document frequency): frequent words weigh as much as rare
  ones in the full-text list.
- RRF ignores how confident each list is: a strong vector match and a weak one at the same rank
  count the same.

### Follow-ups

- A cross-encoder re-ranker on the fused top 20 (roadmap), if the evaluation shows that the right
  section is often retrieved but not ranked first.
- BM25 in Postgres (`pg_search`) if lexical ranking becomes the bottleneck.

## Alternatives considered

- **Vector only:** simplest and, on this dataset, as good (measured above); kept as a strategy,
  and the fallback if a reviewed dataset confirms that hybrid adds nothing.
- **Weighted sum of normalized scores:** needs per-query normalization of two unrelated scales and
  a tuned weight; RRF has one parameter with a standard value.
- **A dedicated search engine (Elasticsearch, Qdrant, Weaviate):** another service to run and keep
  in sync, for a corpus of a few thousand chunks.
