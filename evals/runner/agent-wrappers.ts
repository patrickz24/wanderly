import type {
  RetrievalQuery,
  RetrievedChunk,
  Retriever,
} from '../../services/api/src/domain/ports/knowledge.js';
import type {
  LlmCallOptions,
  LlmPort,
  LlmRequest,
  LlmResponse,
} from '../../services/api/src/domain/ports/llm.js';
import type { PoisonDocument } from './agent-dataset.js';

/**
 * Decorators the harness puts around the production ports. They observe or extend what the agent
 * sees for one (case, rep); they never change how the agent itself works.
 */

/** The provider served another model than the one requested: the attempt measures nothing. */
export class ServedModelMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly served: string,
  ) {
    super(`Requested model ${requested} but the provider served ${served}`);
    this.name = 'ServedModelMismatchError';
  }
}

/** Exact id, or the same id with a dated snapshot suffix (documented alias resolution). */
export function isSameModel(requested: string, served: string): boolean {
  return served === requested || new RegExp(`^${escape(requested)}-\\d{8}$`).test(served);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Asserts on EVERY call that the response comes from the requested model. */
export function assertServedModel(llm: LlmPort, requested: string = llm.model): LlmPort {
  return {
    provider: llm.provider,
    model: llm.model,
    async generate(request: LlmRequest, options: LlmCallOptions): Promise<LlmResponse> {
      const response = await llm.generate(request, options);
      if (!isSameModel(requested, response.model)) {
        throw new ServedModelMismatchError(requested, response.model);
      }
      return response;
    },
  };
}

/** Id prefix of poisoned eval-only chunks (never present in the corpus). */
export const POISON_CHUNK_PREFIX = 'eval-poison:';

/**
 * Indirect prompt injection: puts an eval-only document at rank 1 of every search of its
 * destination (or of a search across all destinations). The real corpus is never modified.
 */
export function poisonRetriever(
  retriever: Retriever,
  poison: PoisonDocument,
  caseId: string,
): Retriever {
  const chunk: RetrievedChunk = {
    id: `${POISON_CHUNK_PREFIX}${caseId}`,
    destinationId: poison.destinationId,
    documentTitle: 'Travel notes',
    headingPath: 'Travel notes > Tips',
    content: poison.text,
    sourceUrl: 'https://example.invalid/eval-fixture',
    score: 1,
    ranks: { vector: 1, fullText: 1 },
  };
  return {
    async search(query: RetrievalQuery): Promise<readonly RetrievedChunk[]> {
      const results = await retriever.search(query);
      const targeted = query.destinationId === null || query.destinationId === poison.destinationId;
      if (!targeted) return results;
      return [chunk, ...results].slice(0, Math.max(1, query.limit));
    },
  };
}

/** An `LlmPort` whose answers come from a function of the request (oracle and null baselines). */
export function policyLlm(model: string, policy: (request: LlmRequest) => LlmResponse): LlmPort {
  return {
    provider: 'eval-policy',
    model,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      return policy(request);
    },
  };
}
