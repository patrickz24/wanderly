# ADR 0004: Local embeddings with bge-small-en-v1.5 behind the `Embedder` port

- **Status:** Accepted
- **Date:** 2026-10-10
- **Milestone:** 2

## Context

Vector search needs an embedding model at ingestion (every chunk) and at query time (every
`search_knowledge` call). A hosted API (Voyage AI, OpenAI) would add a second provider, a second
secret and a per-call cost, and would prevent the retrieval evaluation from running in CI on pull
requests from forks, which get no secrets. The corpus is English (the agent rewrites its search
queries in English), and the demo must run on a small host.

## Decision

Run **`bge-small-en-v1.5`** (384 dimensions, 512-token window) locally with **Transformers.js**
on ONNX Runtime CPU (`Xenova/bge-small-en-v1.5`, fp32 weights), behind the domain's `Embedder`
port (`services/api/src/infrastructure/embeddings/transformers-embedder.ts`).

- Settings follow the BAAI model card: **CLS pooling** then L2 normalization, and the query
  instruction "Represent this sentence for searching relevant passages: " on queries only. The
  Transformers.js example on the `Xenova/` mirror uses mean pooling instead; we follow the model's
  training (CLS).
- The model loads lazily, once, and is checked to return 384-dimension vectors (the column is
  `vector(384)`); `/ready` can report it through `createEmbedderReadinessCheck`.
- Texts are embedded in batches sorted by length, so a batch pads little.
- Documents record the embedding model they were indexed with: changing `EMBEDDING_MODEL`
  re-indexes the corpus on the next ingestion.
- A deterministic `HashEmbedder` (bag of words) replaces it in integration tests.

Measured on this project's development host, in a `node:22-bookworm-slim` container (Node 22, linux-x64, 12 logical CPUs visible), numbers
from the evaluation runs unless stated:

- Model load (files already cached): 2 to 3 s. RSS after load: 500 to 531 MB (the evaluation
  process, which also holds the corpus).
- Peak RSS of the evaluation process while embedding 1,678 chunks of about 300 tokens: 1,513 MB.
  During the first full ingestion through the CLI, the container used 1.8 to 2.1 GiB
  (`docker stats`, whole container).
- Throughput on the whole corpus: 2,136 chunks (mean 210 model tokens) in 666 s on the first CLI
  ingestion, with 32-text calls in input order; 1,678 chunks (mean 297 model tokens) in 345 s in
  the evaluation, one call per document with texts sorted by length. The runs differ in texts and
  host load, so this does not measure the gain of sorting.
- Retrieval latency, query embedding included, median over 53 queries: 13 ms (vector) to 18 ms
  (hybrid).
- Window: 2 of the 2,136 default chunks exceed the 512-token window and are truncated.

## Consequences

### Positive

- No second provider, key or per-call cost; the retrieval evaluation runs in CI without secrets.
- Deterministic vectors: the evaluation is reproducible.
- Swapping the model is one adapter (the port and the schema size are the contract).

### Negative

- Ingestion is CPU-bound: embedding the whole corpus takes minutes, not seconds (see the numbers
  above); it runs once per corpus change thanks to the checksums.
- Memory: the ONNX session and its activations weigh hundreds of MB in the API process.
- The image ships `onnxruntime-node` (glibc only: the API image is Debian slim, not Alpine).
- **Known limitation: Windows.** On the Windows 11 development host, `onnxruntime-node` 1.30
  crashes (segmentation fault) when it creates the inference session, with Node 24 and Node 20,
  even with its DLLs next to `node.exe`; the tokenizer alone works. Linux (Docker, CI) is not
  affected; real-model runs on Windows go through a Linux container
  ([EVALUATIONS.md](../EVALUATIONS.md#reproduce)).
- An English-only, small model: lower quality than large hosted models, and no cross-lingual
  retrieval (the agent translates queries).

### Follow-ups

- If memory on the host is too tight, try the int8 (`q8`) weights and measure the recall loss with
  the evaluation, or switch to a hosted model behind the same port (plan B).
- Measure the effect of the query instruction and of the pooling choice with the evaluation runner.

## Alternatives considered

- **Hosted embeddings (Voyage AI, OpenAI):** better quality, no local memory, but a second secret,
  a cost per call and no evaluation on fork pull requests.
- **Postgres-side embeddings (pgml, pgai):** move the model into the database; not available on
  managed Postgres such as Neon, and hides the step we want to show.
- **Larger local models (bge-base, e5-large):** better quality, 2-3x the memory and latency on CPU,
  for a gain to be measured first.
