import type { AgentResponse, Itinerary, SourceRef } from '@wanderly/contracts';
import type { EvidenceRegistry } from '../tools/evidence.js';

/**
 * Grounding checks: everything a response cites must have been returned by a tool during this
 * run, and the numbers it copies (budget, weather month) must equal the tool output it cites.
 * Strict tool use guarantees the shape of the output; these checks are what make it trustworthy.
 *
 * Issues are phrased for the model, which receives them in the repair message.
 */
export function checkGrounding(response: AgentResponse, evidence: EvidenceRegistry): string[] {
  switch (response.type) {
    case 'itinerary':
      return checkItineraryGrounding(response.itinerary, evidence);
    case 'answer':
      return checkRefs(response.sourceRefs, evidence, 'sourceRefs');
    case 'clarification':
    case 'decline':
      return [];
  }
}

function checkItineraryGrounding(itinerary: Itinerary, evidence: EvidenceRegistry): string[] {
  const issues: string[] = [];
  itinerary.days.forEach((day, dayIndex) => {
    day.items.forEach((item, itemIndex) => {
      const path = `itinerary.days[${dayIndex}].items[${itemIndex}]`;
      issues.push(...checkRefs(item.sourceRefs, evidence, `${path}.sourceRefs`));
      for (const ref of item.sourceRefs) {
        const chunk = ref.kind === 'chunk' ? evidence.chunk(ref.id) : undefined;
        if (chunk !== undefined && chunk.destinationId !== itinerary.destinationId) {
          issues.push(
            `${path}.sourceRefs: excerpt ${ref.id} is about ${chunk.destinationId}, not ${itinerary.destinationId}.`,
          );
        }
      }
      if (item.poiId !== null) {
        const poi = evidence.poi(item.poiId);
        if (poi === undefined) {
          issues.push(
            `${path}.poiId: "${item.poiId}" was not returned by search_pois in this turn. Use a returned poiId or null.`,
          );
        } else if (poi.destinationId !== itinerary.destinationId) {
          issues.push(
            `${path}.poiId: "${item.poiId}" belongs to ${poi.destinationId}, not ${itinerary.destinationId}.`,
          );
        }
      }
    });
  });
  issues.push(...checkBudget(itinerary, evidence), ...checkWeather(itinerary, evidence));
  return issues;
}

function checkRefs(refs: readonly SourceRef[], evidence: EvidenceRegistry, path: string): string[] {
  return refs
    .filter((ref) => !evidence.has(ref))
    .map(
      (ref) =>
        `${path}: no ${ref.kind} with id "${ref.id}" was returned by a tool in this turn. Cite only refs copied from this turn's tool results (call the tool again if needed).`,
    );
}

function checkBudget(itinerary: Itinerary, evidence: EvidenceRegistry): string[] {
  const budget = itinerary.budget;
  if (budget === null) return [];
  const cited = evidence.budget(budget.fromToolCallId);
  if (cited === undefined) {
    return [
      `itinerary.budget.fromToolCallId: "${budget.fromToolCallId}" is not the estimateId of an estimate_budget call of this turn.`,
    ];
  }
  // An estimate without prices (null currency and totals) is copied as is, nulls included.
  const estimate = cited.estimate;
  const issues: string[] = [];
  const mismatch = (field: string, expected: unknown, actual: unknown) =>
    issues.push(
      `itinerary.budget.${field}: must be copied from the estimate (${JSON.stringify(expected)}), got ${JSON.stringify(actual)}.`,
    );
  if (estimate.destinationId !== itinerary.destinationId) {
    issues.push(
      `itinerary.budget: the cited estimate is for ${estimate.destinationId}, not ${itinerary.destinationId}.`,
    );
  }
  if (budget.level !== estimate.level) mismatch('level', estimate.level, budget.level);
  if (budget.currency !== estimate.currency)
    mismatch('currency', estimate.currency, budget.currency);
  if (!sameAmount(budget.total, estimate.total)) mismatch('total', estimate.total, budget.total);
  if (!sameAmount(budget.perPerson, estimate.perPerson)) {
    mismatch('perPerson', estimate.perPerson, budget.perPerson);
  }
  if (estimate.days !== itinerary.durationDays) {
    issues.push(
      `itinerary.budget: the cited estimate is for ${estimate.days} day(s) but the itinerary lasts ${itinerary.durationDays}. Call estimate_budget with days=${itinerary.durationDays}.`,
    );
  }
  if (itinerary.travelers !== null && estimate.travelers !== itinerary.travelers) {
    issues.push(
      `itinerary.budget: the cited estimate is for ${estimate.travelers} traveller(s) but the itinerary has ${itinerary.travelers}.`,
    );
  }
  return issues;
}

function checkWeather(itinerary: Itinerary, evidence: EvidenceRegistry): string[] {
  const weather = itinerary.weather;
  if (weather === null) return [];
  const cited = evidence.weather(weather.fromToolCallId);
  if (cited === undefined) {
    return [
      `itinerary.weather.fromToolCallId: "${weather.fromToolCallId}" is not the weatherId of a get_seasonal_weather call of this turn.`,
    ];
  }
  const issues: string[] = [];
  if (cited.fact.destinationId !== itinerary.destinationId) {
    issues.push(
      `itinerary.weather: the cited weather is for ${cited.fact.destinationId}, not ${itinerary.destinationId}.`,
    );
  }
  if (weather.month !== cited.fact.month) {
    issues.push(
      `itinerary.weather.month: the cited weather is for month ${cited.fact.month}, got ${weather.month}.`,
    );
  }
  if (itinerary.month !== null && weather.month !== itinerary.month) {
    issues.push(
      `itinerary.weather.month: ${weather.month} differs from the itinerary month ${itinerary.month}.`,
    );
  }
  return issues;
}

/** Amounts are copied from JSON, so equality within a cent is exact enough. */
function sameAmount(actual: number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) < 0.005;
}
