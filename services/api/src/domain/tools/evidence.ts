import type { SourceRef } from '@wanderly/contracts';
import type { ClimateMonthFact, PoiFact, RetrievedChunk } from '../ports/knowledge.js';
import type { BudgetEstimate } from './budget.js';

/** A `get_seasonal_weather` result, cited by its tool call id. */
export interface WeatherEvidence {
  readonly callId: string;
  readonly fact: ClimateMonthFact;
}

/** An `estimate_budget` result, cited by its tool call id. */
export interface BudgetEvidence {
  readonly callId: string;
  readonly estimate: BudgetEstimate;
}

/**
 * Everything the data tools returned during one run. Grounding checks accept a citation only if
 * it points here: an id the model saw in a tool result of this run, never one from memory or
 * from an earlier turn.
 */
export class EvidenceRegistry {
  readonly #chunks = new Map<string, RetrievedChunk>();
  readonly #pois = new Map<string, PoiFact>();
  readonly #weather = new Map<string, WeatherEvidence>();
  readonly #budgets = new Map<string, BudgetEvidence>();

  recordChunks(chunks: readonly RetrievedChunk[]): void {
    for (const chunk of chunks) this.#chunks.set(chunk.id, chunk);
  }

  recordPois(pois: readonly PoiFact[]): void {
    for (const poi of pois) this.#pois.set(poi.id, poi);
  }

  recordWeather(evidence: WeatherEvidence): void {
    this.#weather.set(evidence.callId, evidence);
  }

  recordBudget(evidence: BudgetEvidence): void {
    this.#budgets.set(evidence.callId, evidence);
  }

  /** Adds everything `other` holds (a tool call's evidence, once its result is delivered). */
  merge(other: EvidenceRegistry): void {
    for (const [id, chunk] of other.#chunks) this.#chunks.set(id, chunk);
    for (const [id, poi] of other.#pois) this.#pois.set(id, poi);
    for (const [id, weather] of other.#weather) this.#weather.set(id, weather);
    for (const [id, budget] of other.#budgets) this.#budgets.set(id, budget);
  }

  chunk(id: string): RetrievedChunk | undefined {
    return this.#chunks.get(id);
  }

  poi(id: string): PoiFact | undefined {
    return this.#pois.get(id);
  }

  weather(callId: string): WeatherEvidence | undefined {
    return this.#weather.get(callId);
  }

  budget(callId: string): BudgetEvidence | undefined {
    return this.#budgets.get(callId);
  }

  has(ref: SourceRef): boolean {
    switch (ref.kind) {
      case 'chunk':
        return this.#chunks.has(ref.id);
      case 'poi':
        return this.#pois.has(ref.id);
      case 'weather':
        return this.#weather.has(ref.id);
      case 'budget':
        return this.#budgets.has(ref.id);
    }
  }

  /** Number of distinct pieces of evidence, by kind (for traces). */
  counts(): Readonly<Record<SourceRef['kind'], number>> {
    return {
      chunk: this.#chunks.size,
      poi: this.#pois.size,
      weather: this.#weather.size,
      budget: this.#budgets.size,
    };
  }
}
