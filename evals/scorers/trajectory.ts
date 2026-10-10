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
  const calls = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_call') calls.set(block.id, block.name);
    }
  }
  const chunks = new Map<string, ChunkEvidence>();
  const pois = new Map<string, PoiEvidence>();
  const weather = new Map<string, WeatherEvidence>();
  const budgets = new Map<string, BudgetEvidence>();
  let dataToolCalls = 0;
  let dataToolErrors = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const name = calls.get(block.toolCallId);
      if (name === undefined || TERMINAL.has(name)) continue;
      dataToolCalls += 1;
      if (block.isError) {
        dataToolErrors += 1;
        continue;
      }
      const output = parseJson(block.content);
      switch (name) {
        case 'search_knowledge': {
          const parsed = KnowledgeOutput.safeParse(output);
          if (!parsed.success) break;
          for (const result of parsed.data.results) {
            if (result.ref.kind === 'chunk') {
              chunks.set(result.ref.id, { id: result.ref.id, destinationId: result.destinationId });
            }
          }
          break;
        }
        case 'search_pois': {
          const parsed = PoisOutput.safeParse(output);
          if (!parsed.success) break;
          for (const result of parsed.data.results) {
            pois.set(result.poiId, { id: result.poiId, kinds: result.kinds });
          }
          break;
        }
        case 'get_seasonal_weather': {
          const parsed = WeatherOutput.safeParse(output);
          if (parsed.success) {
            const { weatherId, destinationId, month } = parsed.data;
            weather.set(weatherId, { id: weatherId, destinationId, month });
          }
          break;
        }
        case 'estimate_budget': {
          const parsed = BudgetOutput.safeParse(output);
          if (parsed.success) {
            const { estimateId, ...rest } = parsed.data;
            budgets.set(estimateId, { id: estimateId, ...rest });
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return { chunks, pois, weather, budgets, dataToolCalls, dataToolErrors };
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
  const outputs: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'text') outputs.push(block.text);
      if (block.type === 'tool_call') outputs.push(JSON.stringify(block.input));
    }
  }
  return outputs;
}
