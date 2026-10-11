import { createHash } from 'node:crypto';
import type { ToolSpec } from '../ports/llm.js';
import { AGENT_TOOL_SPECS } from '../tools/registry.js';
import { createCatalog } from './catalog.js';
import { buildSystemPrompt, PROMPT_VERSION } from './system-prompt.js';

/** What the model is given besides the conversation: the parts a prompt version identifies. */
export interface PromptParts {
  /** The system prompt as the code builds it. */
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  readonly model: string;
}

const FINGERPRINT_LENGTH = 12;

/** Short, stable hash of the prompt parts (12 hex characters of SHA-256). */
export function promptFingerprint(parts: PromptParts): string {
  const canonical = JSON.stringify({
    system: parts.system,
    tools: parts.tools,
    model: parts.model,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * The system prompt is rendered with this fixed catalog and canary, so the version identifies the
 * template and the code that renders it, not the ingested corpus (data) or the canary (a secret
 * that must not be derivable from a published hash).
 */
const TEMPLATE_CATALOG = createCatalog([
  { id: 'example', name: 'Example', country: 'Exampleland', aliases: ['Sample'] },
]);
const TEMPLATE_CANARY = 'prompt-version-placeholder-canary';

/**
 * Version of what drives the agent's behaviour besides the conversation: `agent-v1-<hash>`, where
 * the hash covers the system prompt template, every tool spec (names, descriptions and the strict
 * schemas generated from the contracts) and the model id. Computed once at startup; traces and
 * `agent_runs.prompt_version` carry it, so a regression can be tied to a prompt change even when
 * nobody bumped `PROMPT_VERSION`.
 */
export function agentPromptVersion(
  model: string,
  tools: readonly ToolSpec[] = AGENT_TOOL_SPECS,
): string {
  const system = buildSystemPrompt(TEMPLATE_CATALOG, TEMPLATE_CANARY);
  return `${PROMPT_VERSION}-${promptFingerprint({ system, tools, model })}`;
}
