# Evaluations

How Wanderly measures what it ships. This document covers the **retrieval evaluation**
(milestone 2); the agent evaluation and the LLM-as-judge (milestone 5) will be added here. The
methodology is written by hand; the results between the `retrieval-results` markers are written by
the runner and must not be edited by hand.

## Retrieval

### What is measured

Whether the knowledge base returns the passages that answer a query, independently of the agent
and of any LLM: deterministic, free, and runnable in CI without a secret. It decides the chunking
parameters and the retrieval strategy (ADRs [0003](adr/0003-corpus-and-structure-aware-chunking.md),
[0004](adr/0004-local-embeddings.md) and [0005](adr/0005-hybrid-retrieval-with-rrf.md)).

The runner exercises the production code: it ingests the real corpus (`data/corpus`, 20 region
guides and their place articles) with the `IngestCorpus` use case and the real local embedding
model into a scratch Postgres + pgvector database per chunking variant, then sends every query
through the production `PgRetriever`. Nothing is reimplemented for the evaluation except the
fixed-size baseline chunker, which exists only to be compared with.

### Dataset

`evals/datasets/retrieval.yaml`: 53 queries over the 20 destinations and some place articles,
written from the corpus text in four styles: keyword (`Maelstrom tidal current`), paraphrase that
avoids the source's words (`walks along old irrigation water channels` for Madeira's levadas),
question (`Should I leave a tip at restaurants in Iceland?`) and cross-section, where the answer is
spread over several sections, documents or destinations (`where to buy lavender oil`). 27 queries
carry the destination filter the agent would pass; the others search the whole corpus.

Each query is labelled with the sections that answer it, as
`(destinationId, document, headingPath)`, for example
`(sicily, places/palermo.md, Stay safe)`. **Labels name sections, never chunk ids**, so they survive
re-chunking. The runner checks before every run that each label names an existing section.

**Provenance.** Every query and label was proposed by the build agent from the corpus text and is
marked `provenance: proposed-by-agent, pending human review`. The plan requires a human to review
them (and ideally to add queries of their own) before these numbers are used as more than a
development signal.

### Relevance and metrics

A retrieved chunk is relevant to a label when it comes from the labelled document and one of the
sections it covers is the labelled section or one of its subsections. A section split into three
chunks therefore has three relevant chunks; a chunk that merges two small sections is relevant to
both. The retriever returns the top 10 chunks; per query:

- **Recall@k** (k = 5, 10): share of the labelled sections found in the top k (each counts once).
- **MRR@10**: 1 / rank of the first relevant chunk, 0 if none in the top 10.
- **Hit@k** (k = 1, 5): 1 if a relevant chunk is in the top k.

Metrics are averaged over queries (every query weighs the same). With about fifty queries one
query moves a mean by about two points, so the table gives **95 % percentile bootstrap intervals**
(2,000 resamples of the queries, fixed seed) and the comparisons that back a decision are **paired
differences** on the same queries, with their own bootstrap interval. A difference whose interval
contains 0 is not established by this dataset.

### Configurations compared

- **Strategies** (production `PgRetriever` options): `vector` (cosine top 20 on the HNSW index),
  `fulltext` (`websearch_to_tsquery('english')` ranked by `ts_rank_cd`, top 20) and `hybrid` (both
  lists fused with Reciprocal Rank Fusion, k = 60). Full text runs in two modes: **all words**
  (`websearch_to_tsquery` as is: every word must match) and **any word** (the words joined with the
  websearch `or` operator, so `ts_rank_cd` ranks partial matches).
- **Chunking**: the structure-aware chunker with its default parameters, against a **fixed-size
  baseline** (300-token windows, 40 tokens of overlap, no structure, no contextual header).
- **Embeddings**: `Xenova/bge-small-en-v1.5`, fp32 ONNX on CPU, CLS pooling, L2-normalized, BGE
  query instruction on queries only.

### Reproduce

```sh
# Postgres 16 + pgvector reachable through DATABASE_URL, with a role allowed to CREATE DATABASE
npm run eval:retrieval -w @wanderly/evals            # prints the table, writes evals/results/<ts>/
npm run eval:retrieval -w @wanderly/evals -- --write # also updates the baseline and this section
```

The run writes the per-query detail (first relevant rank, top-5 sections, latency) to
`evals/results/<timestamp>/retrieval.json` (not versioned) and, with `--write`, the summary to
`evals/baselines/retrieval.json` (versioned). Embeddings are cached in
`evals/results/.embedding-cache/`, keyed by model, embedding settings and text, so a second run
only embeds what changed; `EVAL_SEED_DATABASE_URL` can seed that cache from a database already
ingested with the default chunking.

On Windows the ONNX runtime crashes on this project's development host (see
[ADR 0004](adr/0004-local-embeddings.md)); the measured runs below used a `node:22-bookworm-slim`
container with the repository mounted.

### Results

<!-- retrieval-results:start -->

Run of 2026-10-10, model `Xenova/bge-small-en-v1.5`, 53 queries, top 10.
Metrics in %, with 95 % bootstrap intervals in parentheses. Generated by
`npm run eval:retrieval -w @wanderly/evals -- --write`; do not edit by hand.

| Chunking  | Strategy             | Chunks |         Recall@5 | Recall@10 |           MRR@10 | Hit@1 | Hit@5 | p50 latency |
| --------- | -------------------- | -----: | ---------------: | --------: | ---------------: | ----: | ----: | ----------: |
| structure | vector               |   2136 | 79.2 (68.9–89.6) |      82.1 | 75.0 (64.1–84.9) |  67.9 |  81.1 |       13 ms |
| structure | fulltext (all words) |   2136 | 23.6 (12.3–35.8) |      23.6 | 26.4 (15.1–37.7) |  26.4 |  26.4 |       10 ms |
| structure | fulltext (any word)  |   2136 | 59.7 (47.5–72.0) |      78.6 | 51.6 (40.9–63.2) |  39.6 |  64.2 |       12 ms |
| structure | hybrid (all words)   |   2136 | 80.2 (69.8–89.6) |      83.0 | 75.0 (64.4–84.5) |  66.0 |  83.0 |       16 ms |
| structure | hybrid (any word)    |   2136 | 81.1 (70.8–90.6) |      85.2 | 69.7 (59.5–79.7) |  58.5 |  84.9 |       18 ms |
| fixed-300 | vector               |   1678 | 68.9 (57.5–80.2) |      77.4 | 63.3 (52.3–74.5) |  54.7 |  71.7 |       15 ms |
| fixed-300 | fulltext (all words) |   1678 | 32.1 (20.8–45.3) |      32.1 | 34.9 (22.6–48.1) |  34.0 |  35.8 |       10 ms |
| fixed-300 | fulltext (any word)  |   1678 | 63.5 (51.3–75.5) |      74.5 | 53.8 (42.9–64.9) |  41.5 |  67.9 |       15 ms |
| fixed-300 | hybrid (all words)   |   1678 | 71.7 (60.4–83.0) |      78.3 | 66.4 (56.0–77.9) |  56.6 |  77.4 |       22 ms |
| fixed-300 | hybrid (any word)    |   1678 | 73.6 (62.3–84.9) |      79.6 | 65.2 (54.0–76.5) |  56.6 |  75.5 |       19 ms |

Paired differences (same queries, 95 % bootstrap interval):

- structure/hybrid (any word) − structure/vector, mrrAt10: -5.3 points (95 % CI -13.0 to 1.9)
- structure/hybrid (any word) − structure/vector, recallAt5: 1.9 points (95 % CI -3.8 to 7.5)
- structure/hybrid (any word) − structure/fulltext (any word), mrrAt10: 18.0 points (95 % CI 9.2 to 27.2)
- structure/hybrid (any word) − structure/fulltext (any word), recallAt5: 21.4 points (95 % CI 10.4 to 33.0)
- structure/hybrid (any word) − structure/hybrid (all words), mrrAt10: -5.3 points (95 % CI -12.9 to 2.2)
- structure/hybrid (any word) − structure/hybrid (all words), recallAt5: 0.9 points (95 % CI -4.7 to 6.6)
- structure/fulltext (any word) − structure/fulltext (all words), mrrAt10: 25.2 points (95 % CI 14.2 to 37.3)
- structure/fulltext (any word) − structure/fulltext (all words), recallAt5: 36.2 points (95 % CI 22.6 to 50.0)
- structure/hybrid (any word) − fixed-300/hybrid (any word), mrrAt10: 4.4 points (95 % CI -2.4 to 11.9)
- structure/hybrid (any word) − fixed-300/hybrid (any word), recallAt5: 7.5 points (95 % CI 0.9 to 16.0)
- structure/vector − fixed-300/vector, mrrAt10: 11.7 points (95 % CI 1.1 to 21.7)
- structure/vector − fixed-300/vector, recallAt5: 10.4 points (95 % CI 2.8 to 18.9)

Chunking variants:

```json
{
  "structure": {
    "fingerprint": "md-v1;target=300;max=450;overlap=30;min=60;header=on",
    "chunks": 2136,
    "ingestSeconds": 6,
    "newlyEmbedded": 0,
    "meanModelTokens": 210,
    "overModelLimit": 2
  },
  "fixed-300": {
    "fingerprint": "fixed-v1;size=300;overlap=40;header=off",
    "chunks": 1678,
    "ingestSeconds": 5.4,
    "newlyEmbedded": 0,
    "meanModelTokens": 297,
    "overModelLimit": 0
  }
}
```

<!-- retrieval-results:end -->

### Limitations

- **Labels proposed by the agent**, not by a human, and not double-annotated: no inter-annotator
  agreement is available. A biased labeller can favour the phrasing of the guides; paraphrase
  queries were written to limit this, without any guarantee.
- **Small n.** 53 queries: intervals are wide, and small differences between configurations are
  noise. Decisions rely on paired differences whose interval excludes 0, and say so when it does not.
- **Section granularity.** A label names a whole section; a chunk from the right section that
  does not contain the answer (long sections are split) still counts as relevant. The metrics
  measure "found the right section", not "found the sentence".
- **One corpus revision, one model.** Results hold for this corpus snapshot and
  `bge-small-en-v1.5`; a new corpus revision or model needs a new run (the runner makes it one
  command).
- **English queries only**, as the agent rewrites search queries in English (plan section 1.2).
- **Latency** is measured inside the runner on a shared development machine, including the query
  embedding; it is indicative only.
