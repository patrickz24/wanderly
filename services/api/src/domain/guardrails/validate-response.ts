import type { AgentResponse } from '@wanderly/contracts';
import type { DestinationCatalog } from '../agent/catalog.js';
import type { EvidenceRegistry } from '../tools/evidence.js';
import { checkConsistency } from './consistency.js';
import { checkGrounding } from './grounding.js';

export interface ResponseCheckContext {
  readonly evidence: EvidenceRegistry;
  readonly catalog: DestinationCatalog;
}

/**
 * Semantic validation of a schema-valid response: business consistency, then grounding. An empty
 * list means the response may be shown; otherwise the issues go back to the model for a repair.
 */
export function validateResponse(response: AgentResponse, context: ResponseCheckContext): string[] {
  return [
    ...checkConsistency(response, context.catalog),
    ...checkGrounding(response, context.evidence),
  ];
}
