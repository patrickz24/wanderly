import type { BudgetLevel } from '@wanderly/contracts';
import type { CostFacts, CostFigure } from '../ports/knowledge.js';

/**
 * Trip budget arithmetic over the corpus cost facts. Pure: no I/O, no estimation. Every number
 * in the result is a figure from the guide (a median of listing prices) or arithmetic on those
 * figures; when a figure is missing the result says so (`null` plus a note) instead of guessing,
 * and currencies are never converted.
 */

/** Meals paid per traveller per day (breakfast is often included in lodging). */
export const MEALS_PER_DAY = 2;
/** Lodging prices are per room (or per bed / person, depending on the listing). */
export const TRAVELERS_PER_ROOM = 2;

export interface BudgetRequest {
  readonly destinationId: string;
  /** Trip length in days; nights = days - 1. */
  readonly days: number;
  readonly travelers: number;
  readonly level: BudgetLevel;
}

export interface LodgingLine {
  readonly perNight: number;
  readonly nights: number;
  readonly rooms: number;
  readonly subtotal: number;
  readonly currency: string;
  /** Number of listings the median comes from. */
  readonly sampleSize: number;
}

export interface MealsLine {
  readonly perMeal: number;
  readonly mealsPerDay: number;
  readonly days: number;
  readonly travelers: number;
  readonly subtotal: number;
  readonly currency: string;
  readonly sampleSize: number;
}

export interface BudgetEstimate {
  readonly destinationId: string;
  readonly level: BudgetLevel;
  readonly days: number;
  readonly nights: number;
  readonly travelers: number;
  readonly rooms: number;
  /** Currency of the figures as written in the guide; null when there is no usable figure. */
  readonly currency: string | null;
  readonly lodging: LodgingLine | null;
  readonly meals: MealsLine | null;
  /** Lodging + meals, only when both are known in the same currency. */
  readonly total: number | null;
  readonly perPerson: number | null;
  readonly notes: readonly string[];
}

export function estimateBudget(costs: CostFacts | null, request: BudgetRequest): BudgetEstimate {
  const nights = Math.max(request.days - 1, 0);
  const rooms = Math.ceil(request.travelers / TRAVELERS_PER_ROOM);
  const notes: string[] = [
    `Assumes ${nights} night(s) for ${request.days} day(s), ${rooms} room(s) for ${request.travelers} traveller(s) and ${MEALS_PER_DAY} paid meals per person per day.`,
  ];
  const base = {
    destinationId: request.destinationId,
    level: request.level,
    days: request.days,
    nights,
    travelers: request.travelers,
    rooms,
  };

  if (costs === null) {
    notes.push('The guide has no cost information for this destination.');
    return freeze({
      ...base,
      currency: null,
      lodging: null,
      meals: null,
      total: null,
      perPerson: null,
      notes,
    });
  }

  const fact = costs.levels[request.level];
  notes.push(...fact.notes);
  const lodging = fact.lodgingNight === null ? null : lodgingLine(fact.lodgingNight, nights, rooms);
  const meals = fact.meal === null ? null : mealsLine(fact.meal, request.days, request.travelers);
  if (lodging === null) notes.push(`No ${request.level} lodging price in the guide.`);
  if (meals === null) notes.push(`No ${request.level} meal price in the guide.`);
  if (lodging !== null) {
    notes.push(
      `Lodging: median of ${lodging.sampleSize} listing(s); prices are quoted per room, per bed or per person depending on the listing.`,
    );
  }
  if (meals !== null) {
    notes.push(`Meals: median price of ${meals.sampleSize} listing(s), as quoted by each listing.`);
  }

  const currencies = new Set([lodging?.currency, meals?.currency].filter((c) => c !== undefined));
  if (currencies.size > 1) {
    notes.push(
      'Lodging and meal prices use different currencies; no conversion is made, so there is no total.',
    );
  }
  const currency = currencies.size === 1 ? ([...currencies][0] ?? null) : null;
  const total =
    lodging !== null && meals !== null && currencies.size === 1
      ? round2(lodging.subtotal + meals.subtotal)
      : null;
  if (total === null && currencies.size === 1) {
    notes.push('Only part of the budget has a price in the guide, so there is no total.');
  }
  const perPerson = total === null ? null : round2(total / request.travelers);
  return freeze({ ...base, currency, lodging, meals, total, perPerson, notes });
}

function lodgingLine(figure: CostFigure, nights: number, rooms: number): LodgingLine {
  return {
    perNight: figure.median,
    nights,
    rooms,
    subtotal: round2(figure.median * nights * rooms),
    currency: figure.currency,
    sampleSize: figure.sampleSize,
  };
}

function mealsLine(figure: CostFigure, days: number, travelers: number): MealsLine {
  return {
    perMeal: figure.median,
    mealsPerDay: MEALS_PER_DAY,
    days,
    travelers,
    subtotal: round2(figure.median * MEALS_PER_DAY * days * travelers),
    currency: figure.currency,
    sampleSize: figure.sampleSize,
  };
}

/** Cents precision, to avoid floating-point noise such as 0.30000000000000004. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function freeze(estimate: BudgetEstimate): BudgetEstimate {
  return Object.freeze({ ...estimate, notes: Object.freeze([...estimate.notes]) });
}
