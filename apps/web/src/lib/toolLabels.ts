import { destinationName, monthName } from './format';

/**
 * Human labels for the agent's tool calls, shown in the live progress timeline. Tool inputs
 * come from the model and are typed `unknown` by the contract, so every field is read
 * defensively: anything unexpected falls back to a generic label instead of breaking the UI.
 */

/** Crowd levels go from 1 (empty) to 5 (packed); 2 or less reads as "quiet". */
const QUIET_CROWD_LEVEL = 2;
const MAX_QUERY_CHARS = 60;

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown): Fields {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Fields)
    : {};
}

function stringField(fields: Fields, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function integerField(fields: Fields, key: string, min: number, max: number): number | null {
  const value = fields[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function stringArrayField(fields: Fields, key: string): string[] {
  const value = fields[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function shorten(text: string): string {
  return text.length <= MAX_QUERY_CHARS ? text : `${text.slice(0, MAX_QUERY_CHARS - 1)}…`;
}

function humanList(words: readonly string[]): string {
  if (words.length <= 1) {
    return words[0] ?? '';
  }
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function inDestination(fields: Fields): string {
  const id = stringField(fields, 'destinationId');
  return id === null ? '' : ` in ${destinationName(id)}`;
}

function searchKnowledgeLabel(fields: Fields): string {
  const query = stringField(fields, 'query');
  return query === null ? 'Searching the guide' : `Searching the guide for “${shorten(query)}”`;
}

function weatherLabel(fields: Fields): string {
  const month = integerField(fields, 'month', 1, 12);
  const destination = stringField(fields, 'destinationId');
  if (month === null || destination === null) {
    return 'Checking the seasonal weather';
  }
  return `Checking ${monthName(month)} weather in ${destinationName(destination)}`;
}

function budgetLabel(fields: Fields): string {
  const days = integerField(fields, 'days', 1, 365);
  const travelers = integerField(fields, 'travelers', 1, 100);
  const parts = [
    days === null ? null : countLabel(days, 'day'),
    travelers === null ? null : countLabel(travelers, 'traveller'),
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? 'Estimating the budget'
    : `Estimating the budget (${parts.join(', ')})`;
}

function poiLabel(fields: Fields): string {
  const kinds = stringArrayField(fields, 'kinds').map((kind) => kind.replaceAll('_', ' '));
  const maxCrowd = fields.maxCrowd;
  const quiet = typeof maxCrowd === 'number' && maxCrowd <= QUIET_CROWD_LEVEL;
  const noun = kinds.length === 0 ? 'places' : `${humanList(kinds)} spots`;
  return `Finding ${quiet ? 'quiet ' : ''}${noun}${inDestination(fields)}`;
}

const TERMINAL_LABELS: Readonly<Record<string, string>> = {
  present_itinerary: 'Writing the itinerary',
  ask_clarification: 'Preparing follow-up questions',
  answer_question: 'Writing the answer',
  decline: 'Preparing a reply',
};

/**
 * `describeToolCall('get_seasonal_weather', { destinationId: 'sicily', month: 5 })`
 * → "Checking May weather in Sicily".
 */
export function describeToolCall(name: string, input: unknown): string {
  const fields = asFields(input);
  switch (name) {
    case 'search_knowledge':
      return searchKnowledgeLabel(fields);
    case 'get_seasonal_weather':
      return weatherLabel(fields);
    case 'estimate_budget':
      return budgetLabel(fields);
    case 'search_pois':
      return poiLabel(fields);
    default:
      return TERMINAL_LABELS[name] ?? `Running ${name.replaceAll('_', ' ')}`;
  }
}
