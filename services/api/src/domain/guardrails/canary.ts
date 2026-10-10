/**
 * Canary token leak detection. The system prompt carries a secret marker the model must never
 * output; finding it in a response proves the prompt leaked (typically after a prompt-injection
 * attempt), so the response is blocked and the event is traced. A paraphrased leak without the
 * marker is not detected: this is a tripwire, not a guarantee.
 */

export const MIN_CANARY_LENGTH = 16;

/** True when any string inside `value` contains the token (case- and separator-insensitive). */
export function containsCanary(value: unknown, token: string): boolean {
  const needle = normalize(token);
  if (needle.length < MIN_CANARY_LENGTH) {
    throw new Error(`The canary token must have at least ${MIN_CANARY_LENGTH} letters or digits`);
  }
  return strings(value).some((text) => normalize(text).includes(needle));
}

/** Lower-case letters and digits only, so "WANDERLY-canary 42" matches "wanderlycanary42". */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}
