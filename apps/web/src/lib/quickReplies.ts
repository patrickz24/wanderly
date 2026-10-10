import type { TripBrief } from '@wanderly/contracts';

/**
 * One-click answers for clarification questions. Only offered when the choice is explicit and
 * small, so a quick reply never puts words in the user's mouth:
 * 1. the question lists its options ("… (budget, mid or comfort)?", "…: relaxed or active?");
 * 2. it asks about the budget level while the brief has none (the agent's three levels);
 * 3. it is a lone yes/no question.
 * Anything else gets no quick replies: the user types an answer.
 */

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_OPTION_CHARS = 30;
const MAX_OPTION_WORDS = 4;

const PARENTHESISED_LIST = /\(([^()]+)\)\s*\??\s*$/;
const COLON_LIST = /:\s*([^:]+?)\s*\?\s*$/;
const LIST_SEPARATOR = /\s*,\s*(?:or\s+)?|\s+or\s+|\s*\/\s*/i;
/** Examples are not a closed choice: "(e.g. hiking, food)". */
const EXAMPLE_MARKER = /^(?:e\.g\.|eg\b|for example|for instance|such as|like)\s*/i;
const YES_NO_START =
  /^(?:do|does|did|are|is|was|were|would|should|shall|can|could|will|have|has|may|might)\b/i;
const MENTIONS_BUDGET = /\bbudget\b/i;
const HAS_ALTERNATIVE = /\bor\b/i;

export const BUDGET_LEVEL_REPLIES = ['Budget', 'Mid-range', 'Comfort'] as const;
export const YES_NO_REPLIES = ['Yes', 'No'] as const;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isShortOption(option: string): boolean {
  return (
    option.length > 0 &&
    option.length <= MAX_OPTION_CHARS &&
    option.split(/\s+/).length <= MAX_OPTION_WORDS
  );
}

/** Options listed at the end of the question, or `[]` when there is no closed list. */
export function listedOptions(question: string): string[] {
  const match = PARENTHESISED_LIST.exec(question) ?? COLON_LIST.exec(question);
  const list = match?.[1]?.trim();
  if (list === undefined || EXAMPLE_MARKER.test(list)) {
    return [];
  }
  const options = list
    .split(LIST_SEPARATOR)
    .map((option) => option.trim().replace(/[?.!]+$/, ''))
    .filter((option) => option !== '');
  const unique = [...new Set(options.map((option) => option.toLowerCase()))];
  if (
    unique.length !== options.length ||
    options.length < MIN_OPTIONS ||
    options.length > MAX_OPTIONS ||
    !options.every(isShortOption)
  ) {
    return [];
  }
  return options.map(capitalize);
}

export interface QuickReplyContext {
  /** How many questions the clarification asks; yes/no only makes sense for a single one. */
  readonly questionCount: number;
  readonly brief: TripBrief;
}

export function quickRepliesFor(question: string, context: QuickReplyContext): readonly string[] {
  const listed = listedOptions(question);
  if (listed.length > 0) {
    return listed;
  }
  const text = question.trim();
  if (context.brief.budgetLevel === null && MENTIONS_BUDGET.test(text)) {
    return BUDGET_LEVEL_REPLIES;
  }
  if (context.questionCount === 1 && YES_NO_START.test(text) && !HAS_ALTERNATIVE.test(text)) {
    return YES_NO_REPLIES;
  }
  return [];
}
