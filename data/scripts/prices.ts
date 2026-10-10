/**
 * Price parsing for Wikivoyage listing `price=` fields, and cost statistics derived ONLY from them.
 *
 * Rules (documented in data/README.md):
 * - an amount counts only when a currency token is attached to it ("€50", "50 €", "NOK 900",
 *   "From 450 kr") or when it is the other end of a range whose end has one ("€50-80",
 *   "450 kr to 1250 kr");
 * - the first currency found in the string wins; amounts in other currencies are ignored;
 * - a listing is represented by the midpoint of its lowest and highest amount;
 * - statistics are medians over listings that share the majority currency of the group.
 */
import type { CostFigure } from '@wanderly/contracts';

/** Currency tokens recognised next to an amount, longest first. Kept as written in the output. */
const CURRENCY_TOKENS = [
  'US$',
  'EUR',
  'GBP',
  'USD',
  'NOK',
  'ISK',
  'DKK',
  'SEK',
  'CHF',
  'HRK',
  'kr.',
  'kr',
  'kn',
  '€',
  '£',
  '$',
] as const;

export interface ParsedPrice {
  readonly currency: string;
  readonly min: number;
  readonly max: number;
}

const AMOUNT =
  /\d{1,3}(?:[ ,.\u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)/gu;

/** "1,200" / "1.200" / "1 200" → 1200; "8.50" / "8,50" → 8.5. */
export function parseAmount(text: string): number {
  const groups = /^(\d{1,3})((?:[ ,.\u00a0\u202f]\d{3})+)(?:[.,](\d{1,2}))?$/u.exec(text);
  if (groups?.[1] !== undefined && groups[2] !== undefined) {
    const integer = groups[1] + groups[2].replace(/[^\d]/g, '');
    return Number(groups[3] === undefined ? integer : `${integer}.${groups[3]}`);
  }
  return Number(text.replace(',', '.'));
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN_ALTERNATION = CURRENCY_TOKENS.map(escapeRegex).join('|');
/** Currency right before the amount ("€50", "NOK 900", "kr 1 200"). */
const PREFIX = new RegExp(`(?:^|[^\\p{L}])(${TOKEN_ALTERNATION})\\s?$`, 'iu');
/** Currency right after the amount ("50 €", "450 kr", "900 NOK"). */
const SUFFIX = new RegExp(`^\\s?(${TOKEN_ALTERNATION})(?![\\p{L}])`, 'iu');
/** Range connector between two amounts ("-", "–", "to"), possibly around a currency token. */
const RANGE_GAP = new RegExp(
  `^\\s*(?:${TOKEN_ALTERNATION})?\\s*(?:-|–|—|to)\\s*(?:${TOKEN_ALTERNATION})?\\s*$`,
  'iu',
);

/** "eur" → "EUR", "Kr" → "kr": ISO codes upper-case, local abbreviations lower-case. */
function normaliseCurrency(token: string): string {
  if (/^[a-z]{3}$/i.test(token)) return token.toUpperCase();
  return /^[a-z.]+$/i.test(token) ? token.toLowerCase() : token.toUpperCase();
}

const normaliseNullable = (token: string | null): string | null =>
  token === null ? null : normaliseCurrency(token);

interface AmountToken {
  readonly value: number;
  readonly currency: string | null;
  readonly start: number;
  readonly end: number;
}

/** Parses a price field. Returns `null` when no amount has a currency (e.g. "Free", "€€"). */
export function parsePrice(raw: string): ParsedPrice | null {
  const text = raw.replace(/&nbsp;/g, ' ');
  const tokens: AmountToken[] = [...text.matchAll(AMOUNT)].map((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const before = PREFIX.exec(text.slice(Math.max(0, start - 6), start));
    const after = SUFFIX.exec(text.slice(end, end + 6));
    return {
      value: parseAmount(match[0].trim()),
      currency: normaliseNullable(before?.[1] ?? after?.[1] ?? null),
      start,
      end,
    };
  });
  // Range partners inherit the currency of the other end: "€50-80", "450 kr to 1250 kr".
  const resolved = tokens.map((token, index) => {
    if (token.currency !== null) return token;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (previous?.currency && RANGE_GAP.test(text.slice(previous.end, token.start))) {
      return { ...token, currency: previous.currency };
    }
    if (next?.currency && RANGE_GAP.test(text.slice(token.end, next.start))) {
      return { ...token, currency: next.currency };
    }
    return token;
  });
  const currency = resolved.find((token) => token.currency !== null)?.currency ?? null;
  if (currency === null) return null;
  const values = resolved
    .filter((token) => token.currency === currency && Number.isFinite(token.value))
    .map((token) => token.value);
  if (values.length === 0) return null;
  return { currency, min: Math.min(...values), max: Math.max(...values) };
}

const LONG_STAY = /(?:\bper\b|\ba\b|\/)\s*(?:week|month)|\b(?:weekly|monthly)\b/i;

/** "From €900/month", "€400 per week": not a nightly rate, so not usable for lodging per night. */
export const isLongStayPrice = (raw: string): boolean => LONG_STAY.test(raw);

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;
  const lower = sorted[middle - 1] ?? Number.NaN;
  return sorted.length % 2 === 1 ? upper : (lower + upper) / 2;
}

/**
 * Median of listing midpoints, restricted to the most frequent currency (ties: the currency seen
 * first). Returns `null` when no price could be parsed.
 */
export function summarisePrices(prices: readonly ParsedPrice[]): CostFigure | null {
  if (prices.length === 0) return null;
  const counts = new Map<string, number>();
  for (const price of prices) counts.set(price.currency, (counts.get(price.currency) ?? 0) + 1);
  let currency = '';
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      currency = candidate;
      best = count;
    }
  }
  const sample = prices.filter((price) => price.currency === currency);
  return {
    median: round2(median(sample.map((price) => (price.min + price.max) / 2))),
    min: round2(Math.min(...sample.map((price) => price.min))),
    max: round2(Math.max(...sample.map((price) => price.max))),
    currency,
    sample_size: sample.length,
    excluded_other_currency: prices.length - sample.length,
  };
}
