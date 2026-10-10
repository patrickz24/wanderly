import { EMPTY_TRIP_BRIEF, type TripBrief } from '@wanderly/contracts';
import { DEFAULT_AGENT_LIMITS } from '../../src/domain/agent/limits.js';
import type {
  AgentLimits,
  AgentRunDeps,
  AgentRunInput,
  AgentStepEvent,
  ModelPricing,
} from '../../src/domain/agent/types.js';
import type {
  ClimateMonthFact,
  CostFacts,
  DestinationSummary,
  KnowledgeRepository,
  PoiFact,
  PoiQuery,
  RetrievalQuery,
  RetrievedChunk,
  Retriever,
} from '../../src/domain/ports/knowledge.js';
import type { LlmPort } from '../../src/domain/ports/llm.js';
import type {
  Clock,
  LlmCallRecord,
  RunTrace,
  RunTraceEnd,
  ToolCallRecord,
} from '../../src/domain/ports/tracer.js';

/** In-memory fakes of the agent's ports, with a small fixed corpus (Sicily and Crete). */

export const CANARY = 'wanderly-canary-7f3a9c2e5b1d4086';

export const DESTINATIONS: readonly DestinationSummary[] = [
  { id: 'sicily', name: 'Sicily', country: 'Italy', aliases: ['Sicilia', 'Sicile'] },
  { id: 'crete', name: 'Crete', country: 'Greece', aliases: ['Kriti'] },
];

export function chunk(id: string, destinationId: string, content: string): RetrievedChunk {
  return {
    id,
    destinationId,
    documentTitle: destinationId === 'sicily' ? 'Sicily' : 'Crete',
    headingPath: `${destinationId === 'sicily' ? 'Sicily' : 'Crete'} > Do`,
    content,
    sourceUrl: `https://en.wikivoyage.org/wiki/${destinationId}`,
    score: 0.5,
    ranks: { vector: 1, fullText: 1 },
  };
}

export const CHUNKS: readonly RetrievedChunk[] = [
  chunk('chunk-sicily-hiking', 'sicily', 'The Madonie park has quiet hiking trails.'),
  chunk('chunk-sicily-etna', 'sicily', 'Mount Etna can be climbed with a guide.'),
  chunk('chunk-crete-gorge', 'crete', 'The Samaria Gorge is a long hike.'),
];

export function poi(id: string, destinationId: string, kinds: readonly string[]): PoiFact {
  return {
    id,
    destinationId,
    name: id,
    kinds,
    description: `Description of ${id}`,
    crowdLevel: 2,
    bestMonths: [5, 6],
    sourceRef: 'See',
  };
}

export const POIS: readonly PoiFact[] = [
  poi('sicily-madonie', 'sicily', ['hiking', 'nature']),
  poi('sicily-etna', 'sicily', ['nature', 'adventure']),
  poi('crete-samaria', 'crete', ['hiking']),
];

export const CLIMATE: readonly ClimateMonthFact[] = [
  {
    destinationId: 'sicily',
    month: 5,
    avgHighC: 23,
    avgLowC: 16.1,
    rainDays: 8,
    precipitationMm: 67.4,
    attribution: 'Weather data by Open-Meteo.com',
  },
];

const EUR = (median: number, sampleSize = 4) => ({
  median,
  min: median / 2,
  max: median * 2,
  currency: 'EUR',
  sampleSize,
});

export const COSTS: readonly CostFacts[] = [
  {
    destinationId: 'sicily',
    derivation: 'test',
    overall: { lodgingNight: EUR(90), meal: EUR(20), notes: [] },
    levels: {
      budget: { lodgingNight: EUR(50), meal: EUR(12), notes: [] },
      mid: { lodgingNight: EUR(100), meal: EUR(25), notes: [] },
      comfort: { lodgingNight: null, meal: EUR(60), notes: ['No splurge lodging listing.'] },
    },
  },
];

export interface FakeKnowledgeOptions {
  readonly destinations?: readonly DestinationSummary[];
  readonly climate?: readonly ClimateMonthFact[];
  readonly costs?: readonly CostFacts[];
  readonly pois?: readonly PoiFact[];
}

export class FakeKnowledge implements KnowledgeRepository {
  readonly poiQueries: PoiQuery[] = [];
  readonly #options: Required<FakeKnowledgeOptions>;

  constructor(options: FakeKnowledgeOptions = {}) {
    this.#options = {
      destinations: options.destinations ?? DESTINATIONS,
      climate: options.climate ?? CLIMATE,
      costs: options.costs ?? COSTS,
      pois: options.pois ?? POIS,
    };
  }

  async listDestinations() {
    return this.#options.destinations;
  }

  async getClimate(destinationId: string, month: number) {
    return (
      this.#options.climate.find((c) => c.destinationId === destinationId && c.month === month) ??
      null
    );
  }

  async getCosts(destinationId: string) {
    return this.#options.costs.find((c) => c.destinationId === destinationId) ?? null;
  }

  async searchPois(query: PoiQuery) {
    this.poiQueries.push(query);
    return this.#options.pois
      .filter((p) => p.destinationId === query.destinationId)
      .filter((p) => query.kinds.length === 0 || p.kinds.some((k) => query.kinds.includes(k)))
      .slice(0, query.limit);
  }
}

export class FakeRetriever implements Retriever {
  readonly queries: RetrievalQuery[] = [];
  readonly #chunks: readonly RetrievedChunk[];

  constructor(chunks: readonly RetrievedChunk[] = CHUNKS) {
    this.#chunks = chunks;
  }

  async search(query: RetrievalQuery) {
    this.queries.push(query);
    return this.#chunks
      .filter((c) => query.destinationId === null || c.destinationId === query.destinationId)
      .slice(0, query.limit);
  }
}

export interface RecordingTrace extends RunTrace {
  readonly llmCalls: LlmCallRecord[];
  readonly toolCalls: ToolCallRecord[];
  readonly scores: Array<{ name: string; value: number }>;
  readonly ended: RunTraceEnd[];
}

export function recordingTrace(): RecordingTrace {
  const llmCalls: LlmCallRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const scores: Array<{ name: string; value: number }> = [];
  const ended: RunTraceEnd[] = [];
  return {
    traceId: 'trace-1',
    llmCalls,
    toolCalls,
    scores,
    ended,
    llmCall: (record) => llmCalls.push(record),
    toolCall: (record) => toolCalls.push(record),
    score: (name, value) => scores.push({ name, value }),
    end: (result) => ended.push(result),
  };
}

/** A clock that advances by `stepMs` on every reading, so durations are deterministic. */
export function steppingClock(start = '2026-10-10T09:00:00.000Z', stepMs = 10): Clock {
  let current = new Date(start).getTime();
  return {
    now() {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
  };
}

/** Haiku 5.5 rates (prompts ≤ 100K tokens), as verified on 2026-10-09. */
export const TEST_PRICING: ModelPricing = {
  inputPerMTok: 0.1,
  outputPerMTok: 0.5,
  cacheReadPerMTok: 0.01,
  cacheWritePerMTok: 0.125,
};

export const TEST_LIMITS: AgentLimits = { ...DEFAULT_AGENT_LIMITS };

export function runInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run-1',
    conversationId: 'conversation-1',
    history: [],
    userText: 'Plan 2 days in Sicily in May, we like hiking.',
    brief: EMPTY_TRIP_BRIEF,
    today: '2026-10-10',
    ...overrides,
  };
}

export interface TestDeps extends AgentRunDeps {
  readonly trace: RecordingTrace;
  readonly events: AgentStepEvent[];
  readonly knowledge: FakeKnowledge;
  readonly retriever: FakeRetriever;
}

export interface TestDepsOverrides {
  readonly knowledge?: FakeKnowledge;
  readonly retriever?: FakeRetriever;
  readonly clock?: Clock;
  readonly pricing?: ModelPricing;
  readonly canaryToken?: string;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AgentLimits>;
  readonly onEvent?: (event: AgentStepEvent) => void;
}

export function testDeps(llm: LlmPort, overrides: TestDepsOverrides = {}): TestDeps {
  const events: AgentStepEvent[] = [];
  return {
    llm,
    knowledge: overrides.knowledge ?? new FakeKnowledge(),
    retriever: overrides.retriever ?? new FakeRetriever(),
    trace: recordingTrace(),
    clock: overrides.clock ?? steppingClock(),
    pricing: overrides.pricing ?? TEST_PRICING,
    canaryToken: overrides.canaryToken ?? CANARY,
    limits: { ...TEST_LIMITS, ...overrides.limits },
    onEvent: overrides.onEvent ?? ((event) => events.push(event)),
    signal: overrides.signal,
    events,
  };
}

export function brief(overrides: Partial<TripBrief> = {}): TripBrief {
  return { ...EMPTY_TRIP_BRIEF, ...overrides };
}
