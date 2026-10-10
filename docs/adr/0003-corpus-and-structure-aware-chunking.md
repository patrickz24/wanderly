# ADR 0003: Wikivoyage corpus and structure-aware chunking

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 2

## Context

The agent may only state what its tools return, so the knowledge base decides what Wanderly can
answer. The corpus is English Wikivoyage (CC BY-SA 4.0): 20 region guides chosen by the project
owner and 69 place articles they list, converted to Markdown with their heading structure kept
(`data/README.md`). Chunking decides what a search result is: too large and the embedding blurs
several topics and floods the agent's context; too small and a chunk loses the context that makes
it findable ("2 small ski stations" means nothing without "Sicily > Do > Skiing"). The plan asked
for the size to be measured, not posited, and for labels that survive re-chunking.

## Decision

A **structure-aware Markdown chunker** (`services/api/src/domain/rag/chunker.ts`, pure):

1. One chunk per `##` / `###` section; deeper headings stay in their section.
2. Sections under `minTokens` (60) merge with an adjacent sibling when the result fits
   `targetTokens` (300); the merged chunk's breadcrumb is the common parent and it lists every
   section it covers.
3. Sections over `maxTokens` (450) split between paragraphs and list items towards the target,
   with up to 30 tokens of overlap (whole blocks or trailing sentences). A list item, i.e. a
   Wikivoyage listing, is never cut; a paragraph longer than the budget splits between sentences.
4. A **contextual chunk header**, "Sicily > Do > Skiing" (a place article: "Sicily > Palermo >
   See"), is prefixed to the embedded text and stored as `heading_path`, which the full-text
   index also covers.

Budgets use a token estimate: runs of letters/digits count one token per started 7 characters,
symbols one each. Calibrated against the model's WordPiece tokenizer on the 2,749 lines of the
region guides, it matches the real total (ratio 1.000) with a per-line error between -22 % (p5) and
+21 % (p95). Chunk bodies of at most 450 estimated tokens keep the embedded text inside the
model's 512-token window: in the measured run, 2 of 2,136 chunks exceed it (the runner reports the
count with the real tokenizer).

Ingestion is idempotent: a document is re-indexed only when its SHA-256, the embedding model or
the chunking fingerprint (`md-v1;target=300;max=450;overlap=30;min=60;header=on`) changes. On the
real corpus (89 documents, 2,136 chunks) a second run indexed nothing and took 3.5 s.

The evaluation compares this chunker with a fixed-size baseline on the same queries; the measured
results are in [EVALUATIONS.md](../EVALUATIONS.md#results) and are summarized below.

| Chunking (53 queries, top 10)               | Strategy           | Recall@5 | MRR@10 | Hit@5 |
| ------------------------------------------- | ------------------ | -------: | -----: | ----: |
| structure-aware (2,136 chunks)              | vector             |     79.2 |   75.0 |  81.1 |
| fixed 300 tokens, 40 overlap (1,678 chunks) | vector             |     68.9 |   63.3 |  71.7 |
| structure-aware                             | hybrid (all words) |     80.2 |   75.0 |  83.0 |
| fixed 300 tokens, 40 overlap                | hybrid (all words) |     71.7 |   66.4 |  77.4 |

With vector search, the structure-aware chunker gains **10.4 points of Recall@5 (95 % CI 2.8 to
18.9) and 11.7 points of MRR@10 (95 % CI 1.1 to 21.7)** over the fixed-size baseline, paired on
the same queries. Other chunk sizes, the overlap and the header were not swept yet: the parameters
above are the plan's starting values (300 to 500 tokens), validated against the baseline only.

## Consequences

### Positive

- Every chunk is a self-describing unit with its breadcrumb, which helps both retrieval and the
  agent's citations ("source: Sicily > Do > Skiing").
- Labels are sections, so the evaluation survives any change of chunking parameters.
- Listings stay whole: a name, its description and its price are never separated.

### Negative

- The chunker depends on the corpus being well structured Markdown; prose without headings falls
  back to paragraph splitting only.
- Merging small sections makes some chunks cover two topics; their breadcrumb is the common parent.
- The token estimate is approximate; a few chunks can still exceed the model window and be
  truncated (the evaluation reports how many).

### Follow-ups

- Re-run the evaluation when the corpus revision changes, and have the labels reviewed by a human.
- Semantic chunking (similarity breaks) stays on the roadmap; revisit if section-level recall stalls.

## Alternatives considered

- **Fixed-size windows with overlap:** simplest, but cuts listings and ideas in the middle and
  loses the section context; measured as the baseline.
- **Recursive separators** (paragraph, line, sentence): keeps paragraphs whole but ignores the
  heading structure that this corpus has everywhere.
- **Semantic chunking:** an embedding pass per sentence at ingestion for a gain the evaluation
  would have to show first; roadmap.
