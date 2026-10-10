/**
 * Crowd level of a POI from the wording of its source text (pure, lexical, no model).
 *
 * The evidence is the POI's own listing text plus the sentences of its section that name it. A
 * sentence counts when it contains a term of the lexicon below (case-insensitive, whole words):
 * - HIGH_TERMS signal crowds; preceded by a negation ("not crowded", "never busy", "less
 *   crowded") they count as a low signal instead;
 * - LOW_TERMS signal few visitors; a negated low term ("not quiet") is ignored as unclear.
 * High terms about things ("packed with chapels", "crowds of vehicles"), "busy" before a road or
 * traffic word, and sentences with a year (history: "crowds gathered in 1991") are ignored.
 * Level: only high signals → 4 (one sentence) or 5 (two or more); only low signals → 2 (one
 * sentence) or 1 (two or more); both or none → null.
 */

export const HIGH_TERMS = [
  'crowded',
  'overcrowded',
  'crowds',
  'packed',
  'jam-packed',
  'busy',
  'busiest',
  'touristy',
  'tourist trap',
  'tourist traps',
  'hordes',
  'queue',
  'queues',
  'queuing',
  'queueing',
  'long lines',
  'cruise ships',
  'overrun',
  'mobbed',
  'heaving',
] as const;

export const LOW_TERMS = [
  'quiet',
  'quieter',
  'peaceful',
  'tranquil',
  'secluded',
  'off the beaten track',
  'off the beaten path',
  'deserted',
  'few tourists',
  'few visitors',
  'hidden gem',
  'uncrowded',
  'less visited',
] as const;

/** A negation at most two words before a term: "not crowded", "isn't too busy", "away from the crowds". */
const NEGATION =
  /(?:\b(?:not|never|rarely|seldom|hardly|no|without|nor|less|away from|far from|removed from|escape(?: from)?|avoid(?:ing)?)|n't)\s+(?:[\w'-]+\s+){0,2}$/i;

const termPattern = (terms: readonly string[]): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}-])(?:${terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
      .sort((a, b) => b.length - a.length)
      .join('|')})(?![\\p{L}\\p{N}-])`,
    'giu',
  );

const HIGH = termPattern(HIGH_TERMS);
const LOW = termPattern(LOW_TERMS);

export type CrowdSignal = 'high' | 'low' | null;

/** The signal of one sentence: 'high', 'low', or null when it has none or contradicts itself. */
/** "packed with chapels", "crowds of vehicles": a high term about things, not visitors. */
const NOT_ABOUT_PEOPLE =
  /^\s+(?:with|of)\s+(?!(?:tourists?|visitors?|people|crowds|holidaymakers|day-trippers|locals|families|tour\b|bus\b))/i;
/** "busy road", "the busy A82": traffic, not visitors. */
const TRAFFIC =
  /^\s+(?:roads?|streets?|avenues?|av|highways?|motorways?|junctions?|intersections?|traffic|A\d+)\b/i;
/** Sentences with a year are usually history ("crowds gathered in 1991"), not visitor advice. */
const YEAR = /\b(?:1[5-9]\d{2}|20\d{2})\b/;

export function crowdSignal(sentence: string): CrowdSignal {
  if (YEAR.test(sentence)) return null;
  let high = 0;
  let low = 0;
  for (const match of sentence.matchAll(HIGH)) {
    const after = sentence.slice(match.index + match[0].length);
    if (NOT_ABOUT_PEOPLE.test(after)) continue;
    if (/^busy$/i.test(match[0]) && TRAFFIC.test(after)) continue;
    const before = sentence.slice(0, match.index);
    if (NEGATION.test(before)) low++;
    else high++;
  }
  for (const match of sentence.matchAll(LOW)) {
    const before = sentence.slice(0, match.index);
    if (!NEGATION.test(before)) low++;
  }
  if (high > 0 && low === 0) return 'high';
  if (low > 0 && high === 0) return 'low';
  return null;
}

export interface CrowdAssessment {
  readonly level: number | null;
  /** Sentences that carry a signal (empty when level is null). */
  readonly evidence: readonly string[];
}

export function assessCrowd(sentences: readonly string[]): CrowdAssessment {
  const high: string[] = [];
  const low: string[] = [];
  for (const sentence of sentences) {
    const signal = crowdSignal(sentence);
    if (signal === 'high') high.push(sentence);
    if (signal === 'low') low.push(sentence);
  }
  if (high.length > 0 && low.length === 0) {
    return { level: high.length >= 2 ? 5 : 4, evidence: high };
  }
  if (low.length > 0 && high.length === 0) {
    return { level: low.length >= 2 ? 1 : 2, evidence: low };
  }
  return { level: null, evidence: [] };
}
