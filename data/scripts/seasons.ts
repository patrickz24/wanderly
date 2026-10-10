/**
 * Best months of a POI from explicit months and seasons in its source text (pure, lexical).
 *
 * A sentence is used only when it states when to go, when the place is open, or when an event
 * takes place:
 * - month names ("May", "September", abbreviations only inside ranges such as "Apr-Oct") and
 *   seasons are mapped by MONTHS / SEASONS (northern hemisphere: spring 3-5, summer 6-8,
 *   autumn/fall 9-11, winter 12-2); "X to/until/–/through Y" is the inclusive range, wrapping;
 * - a mention is INCLUDED when the sentence has a recommendation, opening or event cue
 *   (POSITIVE_CUES) and EXCLUDED when a closure cue (EXCLUDE_CUES) is in the 40 characters before;
 * - ignored: dates with a year ("May 1890"); day-precise dates ("1 May", "Dec 25") unless the
 *   sentence is about an event (a holiday closure does not close a month); seasons in opening-hours
 *   sentences ("summer 08:00-18:00, winter 08:00-15:00") or in sentences naming both summer and
 *   winter, which describe schedules, not seasons; several month periods with clock times
 *   ("May-Oct 10:00-18:00; Nov-Apr 11:00-17:00"), i.e. year-round schedules; a season named after
 *   a proper noun ("Slovenian spring").
 * Result: the included months minus the excluded ones; with only exclusions ("closed in winter"),
 * every other month. No usable mention, or all 12 months → [] and no evidence.
 */

export const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

export const SEASONS: Readonly<Record<string, readonly number[]>> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11],
  fall: [9, 10, 11],
  winter: [12, 1, 2],
};

export const POSITIVE_CUES =
  /\b(?:best|ideal|recommended|perfect|good time|visit|visited|go|come|open|opens|season|seasonal|only|held|takes place|celebrated|festival|bloom|blooms|flowering|runs|operates|available|hours)\b/i;
export const EXCLUDE_CUES =
  /\b(?:closed|close|closes|shut|avoid|except|not open|no service|banned|no access|impassable)\b/i;
/** Cues that make a day-precise date relevant ("held on 13 December"). */
export const EVENT_CUES =
  /\b(?:held|takes place|take place|celebrated|celebration|festival|fair|feast|parade|procession|games|carnival)\b/i;

const MONTH_WORD =
  'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const SEASON_WORD = '[Ss]pring|[Ss]ummer|[Aa]utumn|[Ww]inter|(?<=\\b(?:in|the|during)\\s)[Ff]all';
/** Month names are case-sensitive ("May" the month, not "may" the verb). */
const TOKEN = `(?:(?:${MONTH_WORD})\\.?|${SEASON_WORD})`;
const MENTION = new RegExp(
  `(?<![\\p{L}])(${TOKEN})(?:\\s*(?:-|–|—|to|until|till|through|thru)\\s*(${TOKEN}))?(?![\\p{L}])`,
  'gu',
);
const YEAR_AFTER = /^\.?,?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?\d{4}\b/;
const DAY_BEFORE = /\b\d{1,2}(?:st|nd|rd|th)?\s*$/;
const DAY_AFTER = /^\s*\d{1,2}(?:st|nd|rd|th)?\b(?![:.]\d)/;
const CLOCK = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(?:AM|PM)\b/;
/** Abbreviations ("Jan", "Mar") alone are too ambiguous (names, words): only used in ranges. */
const FULL_NAMES = new Set(['May', 'June', 'July']);
const isAbbreviation = (token: string): boolean =>
  /^[A-Z][a-z]{2,3}$/.test(token) && !FULL_NAMES.has(token);
/** "May" opening a sentence is more often the verb ("May be closed…"). */
const SENTENCE_START = /(?:^|[.!?"“(*]\s*)$/;
const isSeason = (token: string): boolean => SEASONS[token.toLowerCase()] !== undefined;

/** "the Slovenian spring", "Prague Spring": a capitalised word (not a sentence start) before. */
function namedSeason(before: string): boolean {
  const match = /([\p{L}-]+)\s+$/u.exec(before);
  const word = match?.[1];
  if (match === null || word === undefined || !/^\p{Lu}/u.test(word)) return false;
  const prefix = before.slice(0, match.index).trimEnd();
  return prefix !== '' && !/[.!?:;("“*]$/.test(prefix);
}

function monthsOf(token: string): number[] {
  const word = token.toLowerCase();
  const month = MONTHS[word];
  if (month !== undefined) return [month];
  return [...(SEASONS[word] ?? [])];
}

/** Inclusive range between the first month of `from` and the last month of `to`, wrapping. */
function range(from: string, to: string): number[] {
  const start = monthsOf(from)[0];
  const end = monthsOf(to).at(-1);
  if (start === undefined || end === undefined) return [];
  const months: number[] = [];
  for (let month = start; ; month = (month % 12) + 1) {
    months.push(month);
    if (month === end || months.length === 12) break;
  }
  return months;
}

export interface SentenceMonths {
  readonly included: ReadonlySet<number>;
  readonly excluded: ReadonlySet<number>;
}

const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
/** "1 May to 31 October", "May 15-Sep 15": a range written with days, read as a month range. */
const DATED_RANGE = new RegExp(
  `(?:${DAY}\\s+)?(?:(?:early|mid|late)-?\\s*)?(${MONTH_WORD})\\.?(?:\\s+${DAY}(?![:.]\\d))?\\s*(?:-|–|—|to|until|till|through)\\s*(?:${DAY}\\s+)?(?:(?:early|mid|late)-?\\s*)?(${MONTH_WORD})\\.?(?:\\s+${DAY}(?![:.]\\d))?`,
  'g',
);

export function monthsInSentence(sentence: string): SentenceMonths {
  const included = new Set<number>();
  const excluded = new Set<number>();
  const text = sentence.replace(DATED_RANGE, '$1-$2');
  const positive = POSITIVE_CUES.test(text);
  const event = EVENT_CUES.test(text);
  const firstClock = text.search(CLOCK);
  const clock = firstClock >= 0;
  const scheduleSeasons = clock || (/\bsummer\b/i.test(text) && /\bwinter\b/i.test(text));
  let periods = 0;
  for (const match of text.matchAll(MENTION)) {
    const [whole, rawFrom = '', rawTo] = match;
    const from = rawFrom.replace(/\.$/, '');
    const to = rawTo?.replace(/\.$/, '');
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + whole.length);
    if (YEAR_AFTER.test(after)) continue;
    if (!isSeason(from)) periods++;
    if (to === undefined) {
      if (isAbbreviation(from)) continue;
      if (from === 'May' && SENTENCE_START.test(before)) continue;
      if (isSeason(from) && (scheduleSeasons || namedSeason(before))) continue;
    } else if (isSeason(from) && scheduleSeasons) {
      continue;
    }
    // "closed on bullfighting days in September" closes some days, not the month.
    const window = before.slice(-40);
    const closure = EXCLUDE_CUES.test(window);
    if (closure && /\bdays?\b/i.test(window)) continue;
    const dated = DAY_BEFORE.test(before) || DAY_AFTER.test(after);
    if (dated && (closure || !event)) continue;
    const months = to === undefined ? monthsOf(from) : range(from, to);
    // In opening hours, a period after the first clock time is a variant of a year-round
    // schedule ("Wed-Fri 13:00-18:00; Jul-Aug: daily 11:00-19:00"), not an opening season.
    const scheduleVariant = clock && match.index > firstClock;
    if (closure) {
      months.forEach((month) => excluded.add(month));
    } else if ((positive || event) && !scheduleVariant) {
      months.forEach((month) => included.add(month));
    }
  }
  // Several month periods with clock times are a year-round schedule, not a season.
  if (clock && periods >= 2) included.clear();
  return { included, excluded };
}

export interface MonthsAssessment {
  readonly months: number[];
  /** Sentences that contributed months (empty when months is empty). */
  readonly evidence: readonly string[];
}

export function assessBestMonths(sentences: readonly string[]): MonthsAssessment {
  const included = new Set<number>();
  const excluded = new Set<number>();
  const evidence: string[] = [];
  for (const sentence of sentences) {
    const found = monthsInSentence(sentence);
    if (found.included.size === 0 && found.excluded.size === 0) continue;
    found.included.forEach((month) => included.add(month));
    found.excluded.forEach((month) => excluded.add(month));
    evidence.push(sentence);
  }
  const base =
    included.size > 0
      ? [...included]
      : excluded.size > 0
        ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        : [];
  const months = base.filter((month) => !excluded.has(month)).sort((a, b) => a - b);
  return months.length === 0 || months.length === 12
    ? { months: [], evidence: [] }
    : { months, evidence };
}
