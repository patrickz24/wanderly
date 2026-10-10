import { z } from 'zod';

/**
 * Converts a Zod input schema into a JSON Schema the provider accepts for strict tool use
 * (`strict: true`), so that the model's arguments are constrained to the schema's shape.
 *
 * Strict mode accepts a subset of JSON Schema (Anthropic structured-outputs docs, checked
 * 2026-10-10): every object needs `additionalProperties: false`; numeric bounds, string lengths
 * and array bounds other than `minItems` 0/1 are rejected with a 400; string formats are limited
 * to a fixed list. A request may also carry at most 20 strict tools, 24 optional parameters and
 * 16 parameters with a union type (`anyOf` or a type array) across all its strict schemas.
 *
 * What the conversion does:
 * - every property is required (nullable instead of optional) and objects are closed;
 * - unsupported constraints are removed from the wire schema and restated in the description,
 *   while the original Zod schema still validates them on our side (an invalid call is repaired);
 * - small integer ranges (≤ 31 values, e.g. a month) become enums, and a nullable enum becomes an
 *   enum containing `null`: the range is enforced by the provider, and the field does not spend
 *   the union budget the way `anyOf: [..., {type: "null"}]` does.
 */

export type JsonSchema = Record<string, unknown>;

/** String formats strict mode supports. Others are dropped (and validated by Zod). */
export const STRICT_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** Provider limits per request, summed over every strict schema of the request. */
export const STRICT_LIMITS = Object.freeze({
  tools: 20,
  optionalParameters: 24,
  unionParameters: 16,
});

const MAX_ENUM_RANGE = 31;

/** Keywords the strict grammar rejects; they are restated in the description instead. */
const DROPPED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'format',
  '$schema',
]);

export function isJsonObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param descriptions model-facing descriptions keyed by property path, e.g.
 *   `itinerary.days[].items[].poiId` (`[]` steps into array items). Unknown paths throw, so a
 *   renamed field cannot silently lose its description.
 */
export function toStrictJsonSchema(
  schema: z.ZodType,
  descriptions: Readonly<Record<string, string>> = {},
): JsonSchema {
  const raw: unknown = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  });
  if (!isJsonObject(raw) || raw.type !== 'object') {
    throw new Error('A tool input schema must be a JSON object schema');
  }
  const strict = normalize(raw);
  for (const [path, description] of Object.entries(descriptions)) {
    describeAt(strict, path, description);
  }
  return deepFreeze(strict);
}

function normalize(node: JsonSchema): JsonSchema {
  if (Array.isArray(node.anyOf)) return normalizeAnyOf(node, node.anyOf);
  switch (node.type) {
    case 'object':
      return normalizeObject(node);
    case 'array':
      return normalizeArray(node);
    case 'string':
      return normalizeString(node);
    case 'integer':
    case 'number':
      return normalizeNumber(node);
    default:
      return withHints(keepSupported(node), node, []);
  }
}

function normalizeAnyOf(node: JsonSchema, members: readonly unknown[]): JsonSchema {
  const normalized = members.filter(isJsonObject).map(normalize);
  const nonNull = normalized.filter((member) => member.type !== 'null');
  const [only] = nonNull;
  if (only !== undefined && nonNull.length === 1 && normalized.length === 2) {
    const values = Array.isArray(only.enum) ? only.enum : null;
    if (values !== null) {
      // Nullable enum: `null` joins the enum, no union needed.
      return withDescription(
        { enum: [...values, null] },
        joinText(node.description, only.description),
      );
    }
    return withDescription({ anyOf: [only, { type: 'null' }] }, textOf(node.description));
  }
  return withDescription({ anyOf: normalized }, textOf(node.description));
}

function normalizeObject(node: JsonSchema): JsonSchema {
  const properties = isJsonObject(node.properties) ? node.properties : {};
  const normalized: JsonSchema = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonObject(value)) throw new Error(`Property "${key}" has no schema`);
    normalized[key] = normalize(value);
  }
  return withDescription(
    {
      type: 'object',
      properties: normalized,
      required: Object.keys(normalized),
      additionalProperties: false,
    },
    textOf(node.description),
  );
}

function normalizeArray(node: JsonSchema): JsonSchema {
  if (!isJsonObject(node.items)) throw new Error('Array schemas must declare their items');
  const result: JsonSchema = { type: 'array', items: normalize(node.items) };
  const hints: string[] = [];
  const minItems = numberOf(node.minItems);
  if (minItems !== null && minItems <= 1) result.minItems = minItems;
  else if (minItems !== null) hints.push(`At least ${minItems} items.`);
  const maxItems = numberOf(node.maxItems);
  if (maxItems !== null) hints.push(`At most ${maxItems} items.`);
  return withHints(result, node, hints);
}

function normalizeString(node: JsonSchema): JsonSchema {
  const result = keepSupported(node);
  if (typeof node.format === 'string' && STRICT_STRING_FORMATS.has(node.format)) {
    result.format = node.format;
  }
  const hints: string[] = [];
  const minLength = numberOf(node.minLength);
  if (minLength === 1) hints.push('Non-empty.');
  else if (minLength !== null && minLength > 1) hints.push(`At least ${minLength} characters.`);
  const maxLength = numberOf(node.maxLength);
  if (maxLength !== null) hints.push(`At most ${maxLength} characters.`);
  return withHints(result, node, hints);
}

function normalizeNumber(node: JsonSchema): JsonSchema {
  const minimum = numberOf(node.minimum);
  const maximum = numberOf(node.maximum);
  if (
    node.type === 'integer' &&
    minimum !== null &&
    maximum !== null &&
    maximum - minimum < MAX_ENUM_RANGE &&
    !Array.isArray(node.enum)
  ) {
    const values = Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
    return withDescription({ type: 'integer', enum: values }, textOf(node.description));
  }
  const hints: string[] = [];
  // Zod emits the safe-integer bounds for every `z.int()`: they carry no meaning for the model.
  if (minimum !== null && minimum > Number.MIN_SAFE_INTEGER) hints.push(`Minimum ${minimum}.`);
  if (maximum !== null && maximum < Number.MAX_SAFE_INTEGER) hints.push(`Maximum ${maximum}.`);
  return withHints(keepSupported(node), node, hints);
}

function keepSupported(node: JsonSchema): JsonSchema {
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (!DROPPED_KEYWORDS.has(key) && key !== 'description') result[key] = value;
  }
  return result;
}

function withHints(result: JsonSchema, node: JsonSchema, hints: readonly string[]): JsonSchema {
  return withDescription(result, joinText(node.description, hints.join(' ')));
}

function withDescription(result: JsonSchema, description: string): JsonSchema {
  return description === '' ? result : { ...result, description };
}

function joinText(...parts: readonly unknown[]): string {
  return parts
    .map(textOf)
    .filter((part) => part !== '')
    .join(' ');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Sets the description of the property at `path`, prepending it to the constraint hints. */
function describeAt(root: JsonSchema, path: string, description: string): void {
  let node: JsonSchema = root;
  for (const segment of path.split('.')) {
    const isArrayStep = segment.endsWith('[]');
    const name = isArrayStep ? segment.slice(0, -2) : segment;
    const { properties } = nonNullBranch(node);
    const child = isJsonObject(properties) ? properties[name] : undefined;
    if (!isJsonObject(child)) throw new Error(`Unknown schema path "${path}"`);
    node = child;
    if (isArrayStep) {
      const items = nonNullBranch(node).items;
      if (!isJsonObject(items)) throw new Error(`"${segment}" in "${path}" is not an array`);
      node = items;
    }
  }
  node.description = joinText(description, node.description);
}

function nonNullBranch(node: JsonSchema): JsonSchema {
  if (!Array.isArray(node.anyOf)) return node;
  const branch = node.anyOf.find((member) => isJsonObject(member) && member.type !== 'null');
  return isJsonObject(branch) ? branch : node;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export interface StrictSchemaComplexity {
  /** Parameters typed with `anyOf` or a type array. */
  readonly unionParameters: number;
  /** Properties not listed in `required`. */
  readonly optionalParameters: number;
}

/** Counts what the provider's strict-mode limits count, for one schema. */
export function strictSchemaComplexity(schema: JsonSchema): StrictSchemaComplexity {
  let unionParameters = 0;
  let optionalParameters = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isJsonObject(node)) return;
    if (Array.isArray(node.anyOf) || Array.isArray(node.type)) unionParameters += 1;
    if (isJsonObject(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      optionalParameters += Object.keys(node.properties).filter((key) => !required.has(key)).length;
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  return { unionParameters, optionalParameters };
}

/** Throws when a set of strict tool schemas would be rejected by the provider's limits. */
export function assertWithinStrictLimits(schemas: readonly JsonSchema[]): void {
  const total = schemas.map(strictSchemaComplexity).reduce(
    (sum, item) => ({
      unionParameters: sum.unionParameters + item.unionParameters,
      optionalParameters: sum.optionalParameters + item.optionalParameters,
    }),
    { unionParameters: 0, optionalParameters: 0 },
  );
  const problems = [
    schemas.length > STRICT_LIMITS.tools ? `${schemas.length} strict tools` : null,
    total.unionParameters > STRICT_LIMITS.unionParameters
      ? `${total.unionParameters} union-typed parameters`
      : null,
    total.optionalParameters > STRICT_LIMITS.optionalParameters
      ? `${total.optionalParameters} optional parameters`
      : null,
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new Error(`Strict tool schemas exceed provider limits: ${problems.join(', ')}`);
  }
}
