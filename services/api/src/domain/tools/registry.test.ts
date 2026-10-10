import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_SPECS, DATA_TOOLS, findDataTool } from './registry.js';
import {
  isJsonObject,
  STRICT_LIMITS,
  STRICT_STRING_FORMATS,
  strictSchemaComplexity,
  type JsonSchema,
} from './strict-json-schema.js';
import { findTerminalTool, isTerminalToolName, TERMINAL_TOOL_NAMES } from './terminal-tools.js';

const FORBIDDEN = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  '$schema',
  '$ref',
];

/** Every schema node of a tool, with its path, for rule checks. */
function nodes(schema: unknown, path = '$'): Array<[string, JsonSchema]> {
  if (!isJsonObject(schema)) return [];
  const children: Array<[string, unknown]> = [];
  if (isJsonObject(schema.properties)) {
    for (const [key, value] of Object.entries(schema.properties))
      children.push([`${path}.${key}`, value]);
  }
  if (schema.items !== undefined) children.push([`${path}[]`, schema.items]);
  if (Array.isArray(schema.anyOf))
    schema.anyOf.forEach((member, index) => children.push([`${path}|${index}`, member]));
  return [[path, schema], ...children.flatMap(([childPath, child]) => nodes(child, childPath))];
}

describe('agent tool specs', () => {
  it('offers the four data tools then the four terminal tools, in a fixed order', () => {
    expect(AGENT_TOOL_SPECS.map((spec) => spec.name)).toEqual([
      'search_knowledge',
      'get_seasonal_weather',
      'estimate_budget',
      'search_pois',
      'present_itinerary',
      'ask_clarification',
      'answer_question',
      'decline',
    ]);
  });

  it.each(AGENT_TOOL_SPECS.map((spec) => [spec.name, spec] as const))(
    '%s satisfies the strict tool schema rules',
    (_name, spec) => {
      expect(spec.strict).toBe(true);
      expect(spec.description.length).toBeGreaterThan(80);
      expect(spec.inputSchema.type).toBe('object');
      for (const [path, node] of nodes(spec.inputSchema)) {
        for (const keyword of FORBIDDEN) {
          expect(node, `${path} has ${keyword}`).not.toHaveProperty(keyword);
        }
        if (node.type === 'object') {
          expect(node.additionalProperties, path).toBe(false);
          expect(node.required, path).toEqual(
            Object.keys(isJsonObject(node.properties) ? node.properties : {}),
          );
        }
        if ('minItems' in node) expect([0, 1], path).toContain(node.minItems);
        if (typeof node.format === 'string')
          expect(STRICT_STRING_FORMATS.has(node.format), path).toBe(true);
        expect(Array.isArray(node.type), `${path} uses a type array`).toBe(false);
      }
    },
  );

  it('stays within the per-request strict-mode budget', () => {
    const total = AGENT_TOOL_SPECS.map((spec) => strictSchemaComplexity(spec.inputSchema)).reduce(
      (sum, item) => ({
        unionParameters: sum.unionParameters + item.unionParameters,
        optionalParameters: sum.optionalParameters + item.optionalParameters,
      }),
      { unionParameters: 0, optionalParameters: 0 },
    );
    expect(AGENT_TOOL_SPECS.length).toBeLessThanOrEqual(STRICT_LIMITS.tools);
    expect(total.optionalParameters).toBe(0);
    expect(total.unionParameters).toBeLessThanOrEqual(STRICT_LIMITS.unionParameters);
  });

  it('constrains small ranges with enums the provider enforces', () => {
    const itinerary = findTerminalTool('present_itinerary')?.spec.inputSchema;
    const text = JSON.stringify(itinerary);
    expect(text).toContain('"durationDays":{"type":"integer","enum":[1,2,3');
    expect(text).toContain('"month":{"enum":[1,2,3,4,5,6,7,8,9,10,11,12,null]');
  });

  it('looks tools up by name', () => {
    expect(findDataTool('search_pois')).toBe(DATA_TOOLS[3]);
    expect(findDataTool('present_itinerary')).toBeUndefined();
    expect(TERMINAL_TOOL_NAMES.every(isTerminalToolName)).toBe(true);
    expect(isTerminalToolName('search_pois')).toBe(false);
    expect(findTerminalTool('nope')).toBeUndefined();
  });
});
