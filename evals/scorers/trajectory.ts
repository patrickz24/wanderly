/* eslint-disable @typescript-eslint/no-unused-vars -- learning skeleton: the schemas and helpers are used once the TODOs are implemented; remove this line at the end. */
import type { BudgetLevel } from '@wanderly/contracts';
import { z } from 'zod';
import type { LlmMessage } from '../../services/api/src/domain/ports/llm.js';

/**
 * Evidence index rebuilt from a run's trajectory (the messages of the turn), independently of the
 * runtime's own `EvidenceRegistry`: the evaluation re-derives what each tool returned from the raw
 * tool results the model received, so a bug in the runtime's grounding checks cannot hide itself.
 *
 * Only successful results count (`isError: false`), and only for tool calls made in the same turn.
 */

export interface ChunkEvidence {
  readonly id: string;
  readonly destinationId: string;
}

export interface PoiEvidence {
  readonly id: string;
  readonly kinds: readonly string[];
}

export interface WeatherEvidence {
  readonly id: string;
  readonly destinationId: string;
  readonly month: number;
}

export interface BudgetEvidence {
  readonly id: string;
  readonly destinationId: string;
  readonly level: BudgetLevel;
  readonly days: number;
  readonly travelers: number;
  readonly currency: string | null;
  readonly total: number | null;
  readonly perPerson: number | null;
}

export interface TrajectoryEvidence {
  readonly chunks: ReadonlyMap<string, ChunkEvidence>;
  readonly pois: ReadonlyMap<string, PoiEvidence>;
  readonly weather: ReadonlyMap<string, WeatherEvidence>;
  readonly budgets: ReadonlyMap<string, BudgetEvidence>;
  /** Data tool calls made (terminal calls excluded) and how many came back as errors. */
  readonly dataToolCalls: number;
  readonly dataToolErrors: number;
}

const TERMINAL = new Set(['present_itinerary', 'ask_clarification', 'answer_question', 'decline']);

const RefSchema = z.object({ kind: z.string(), id: z.string() });
const KnowledgeOutput = z.object({
  results: z.array(z.object({ ref: RefSchema, destinationId: z.string() })),
});
const PoisOutput = z.object({
  results: z.array(z.object({ poiId: z.string(), kinds: z.array(z.string()) })),
});
const WeatherOutput = z.object({
  found: z.literal(true),
  weatherId: z.string(),
  destinationId: z.string(),
  month: z.int(),
});
const BudgetOutput = z.object({
  estimateId: z.string(),
  destinationId: z.string(),
  level: z.enum(['budget', 'mid', 'comfort']),
  days: z.int(),
  travelers: z.int(),
  currency: z.string().nullable(),
  total: z.number().nullable(),
  perPerson: z.number().nullable(),
});

/** Builds the evidence index of one turn from its messages (assistant calls + user results). */
export function collectEvidence(messages: readonly LlmMessage[]): TrajectoryEvidence {
  // TODO(learning) — étape 4. Pas de test direct : la spec, ce sont les tests de
  // agent-metrics.test.ts qui lisent les preuves (citation_integrity, numbers_grounded,
  // tool_error_rate, interest_coverage).
  // 1. Premier passage sur les messages ASSISTANT : associe chaque id d'appel à son nom d'outil.
  // 2. Second passage sur les `tool_result` des messages UTILISATEUR :
  //    - ignore un résultat dont l'appel est inconnu, ou qui répond à un outil terminal ;
  //    - compte chaque appel d'outil de données, et ses erreurs (`isError`) : une erreur ne
  //      fournit AUCUNE preuve ;
  //    - sinon parse le JSON (`parseJson`) et valide-le avec le schéma Zod de l'outil (sortie
  //      inattendue -> on l'ignore, sans planter), puis indexe : chunks (refs de kind 'chunk'),
  //      POI (avec leurs kinds), météo (seulement si `found`), budget (par `estimateId`).
  // On re-dérive tout depuis le texte brut que le modèle a reçu, sans réutiliser le registre de
  // preuves du runtime : un bug des garde-fous ne peut pas se cacher lui-même.
  throw new Error('TODO(learning): collectEvidence (eval-metrics, step 4)');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every string the model produced in the turn: text blocks and tool call arguments. */
export function modelOutputs(messages: readonly LlmMessage[]): string[] {
  // TODO(learning) — étape 4. Tout ce que le MODÈLE a écrit (messages assistant seulement) : le
  // texte des blocs texte et les arguments des appels d'outils sérialisés en JSON. Les blocs
  // opaques (raisonnement) ne sont pas lisibles et ne comptent pas. Sert à chercher le canary.
  throw new Error('TODO(learning): modelOutputs (eval-metrics, step 4)');
}
