/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the imports and parameters are used once the TODO is implemented; remove this line at the end. */
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
  // TODO(learning) — étape 4. Spec : guardrails.test.ts, describe('validateResponse').
  // La réponse a déjà passé Zod (la FORME). Ici on vérifie le FOND, en deux familles de règles
  // déjà écrites : la cohérence métier (`checkConsistency` : nombre de jours, catalogue, brief)
  // puis l'ancrage (`checkGrounding` : chaque citation, POI, budget et météo vient d'un outil de
  // CE run). Renvoie toutes les issues, cohérence d'abord (l'ordre est testé). Liste vide = valide.
  throw new Error('TODO(learning): validateResponse (agent-loop, step 4)');
}
