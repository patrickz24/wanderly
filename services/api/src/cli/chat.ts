/**
 * Dev CLI: runs ONE agent turn against the real model and the ingested corpus, without the HTTP
 * layer or persistence, and prints the validated response with its cost.
 *
 *   npx tsx --conditions=development --env-file-if-exists=../../.env src/cli/chat.ts \
 *     "Plan 3 quiet days in Sicily in May, we like hiking"
 *
 *   --brief <json>   trip brief carried over from a previous turn (default: empty)
 *   --json           print the whole run result as JSON
 *
 * Needs the API environment (DATABASE_URL, SESSION_SECRET, ANTHROPIC_API_KEY, LLM_MODEL…) and an
 * ingested corpus. Every run is a real, billed API call.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EMPTY_TRIP_BRIEF, TripBriefSchema, type TripBrief } from '@wanderly/contracts';
import { loadConfig, type Config } from '../config.js';
import { DEFAULT_AGENT_LIMITS } from '../domain/agent/limits.js';
import { runAgent } from '../domain/agent/run-agent.js';
import type { AgentLimits, AgentRunResult, AgentStepEvent } from '../domain/agent/types.js';
import { NOOP_RUN_TRACE, SYSTEM_CLOCK } from '../domain/ports/tracer.js';
import { createPool } from '../infrastructure/db/pool.js';
import { TransformersEmbedder } from '../infrastructure/embeddings/transformers-embedder.js';
import { PgKnowledgeRepository } from '../infrastructure/knowledge/pg-knowledge-repository.js';
import { PgRetriever } from '../infrastructure/knowledge/pg-retriever.js';
import { createAnthropicLlm } from '../infrastructure/llm/anthropic-llm.js';
import { pricingFor } from '../infrastructure/llm/pricing.js';

export interface ChatCliOptions {
  readonly text: string;
  readonly brief: TripBrief;
  readonly json: boolean;
}

export function parseChatArgs(argv: readonly string[]): ChatCliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { brief: { type: 'string' }, json: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: true,
  });
  const text = positionals.join(' ').trim();
  if (text === '') throw new Error('Usage: chat.ts [--brief <json>] [--json] "<message>"');
  const brief =
    values.brief === undefined ? EMPTY_TRIP_BRIEF : TripBriefSchema.parse(JSON.parse(values.brief));
  return { text, brief, json: values.json };
}

/** Run limits from the validated config; the rest keeps the runtime defaults. */
export function agentLimits(config: Config): AgentLimits {
  return {
    ...DEFAULT_AGENT_LIMITS,
    maxSteps: config.agent.maxSteps,
    llmTimeoutMs: config.llm.timeoutMs,
    runDeadlineMs: config.agent.runDeadlineMs,
    maxRunCostUsd: config.agent.maxRunCostUsd ?? DEFAULT_AGENT_LIMITS.maxRunCostUsd,
  };
}

export function formatEvent(event: AgentStepEvent): string {
  if (event.type === 'tool.started') {
    return `→ ${event.name} ${JSON.stringify(event.input)}`;
  }
  const { call } = event;
  return `${call.ok ? '✓' : '✗'} ${call.name} (${call.durationMs} ms): ${call.summary}`;
}

export function formatResult(result: AgentRunResult): string {
  const footer = [
    `steps ${result.steps}, repairs ${result.repairs}, tool calls ${result.toolCalls.length}`,
    `tokens in ${result.usage.inputTokens} / out ${result.usage.outputTokens} / cache read ${result.usage.cacheReadTokens} / cache write ${result.usage.cacheWriteTokens}`,
    `cost ${result.costUsd.toFixed(6)} USD, ${result.latencyMs} ms`,
  ];
  if (result.status === 'error') {
    return [
      `ERROR ${result.error.code} (${result.reason}): ${result.error.message}`,
      ...footer,
    ].join('\n');
  }
  return [
    `${result.response.type.toUpperCase()}${result.validFirstTry ? '' : ' (after repair)'}`,
    JSON.stringify(result.response, null, 2),
    `sources: ${result.sources.map((source) => `${source.kind}:${source.id}`).join(', ') || 'none'}`,
    ...footer,
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseChatArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const apiKey = config.llm.anthropicApiKey;
  if (apiKey === undefined) throw new Error('ANTHROPIC_API_KEY is not set');

  const pool = createPool({
    url: config.database.url,
    onIdleClientError: (error) => console.error('idle Postgres client error:', error.message),
    max: 2,
  });
  const embedder = new TransformersEmbedder({
    model: config.embeddings.model,
    cacheDir: config.embeddings.cacheDir,
  });
  try {
    const llm = createAnthropicLlm({
      apiKey: apiKey.reveal(),
      model: config.llm.model,
      effort: config.llm.effort,
      timeoutMs: config.llm.timeoutMs,
    });
    const result = await runAgent(
      {
        runId: 'cli',
        conversationId: 'cli',
        history: [],
        userText: options.text,
        brief: options.brief,
        today: new Date().toISOString().slice(0, 10),
      },
      {
        llm,
        retriever: new PgRetriever(pool, embedder),
        knowledge: new PgKnowledgeRepository(pool),
        trace: NOOP_RUN_TRACE,
        clock: SYSTEM_CLOCK,
        limits: agentLimits(config),
        pricing: pricingFor(config.llm.model),
        canaryToken: config.agent.canaryToken.reveal(),
        onEvent: (event) => console.error(formatEvent(event)),
      },
    );
    console.log(options.json ? JSON.stringify(result, null, 2) : formatResult(result));
    if (result.status === 'error') process.exitCode = 1;
  } finally {
    await embedder.close();
    await pool.end();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error('Chat failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
