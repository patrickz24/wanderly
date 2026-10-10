import type { ToolSpec } from '../ports/llm.js';
import { estimateBudgetTool } from './estimate-budget.js';
import { getSeasonalWeatherTool } from './get-seasonal-weather.js';
import { searchKnowledgeTool } from './search-knowledge.js';
import { searchPoisTool } from './search-pois.js';
import { assertWithinStrictLimits } from './strict-json-schema.js';
import { TERMINAL_TOOLS } from './terminal-tools.js';
import type { DataTool } from './tool.js';

/** Read-only tools that gather evidence. */
export const DATA_TOOLS: readonly DataTool[] = Object.freeze([
  searchKnowledgeTool,
  getSeasonalWeatherTool,
  estimateBudgetTool,
  searchPoisTool,
]);

/**
 * Every tool offered to the model, in a fixed order. The list is static for the life of the
 * deployment: tools render first in the provider's prompt, so any change invalidates the prompt
 * cache and the reasoning blocks of ongoing conversations.
 */
export const AGENT_TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  ...DATA_TOOLS.map((tool) => tool.spec),
  ...TERMINAL_TOOLS.map((tool) => tool.spec),
]);

// Fail at startup, not with a 400 on the first request, if the schemas outgrow strict mode.
assertWithinStrictLimits(
  AGENT_TOOL_SPECS.filter((spec) => spec.strict).map((spec) => spec.inputSchema),
);

const DATA_TOOLS_BY_NAME = new Map(DATA_TOOLS.map((tool) => [tool.spec.name, tool]));

export function findDataTool(name: string): DataTool | undefined {
  return DATA_TOOLS_BY_NAME.get(name);
}
