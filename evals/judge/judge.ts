import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { costUsd } from '../../services/api/src/domain/pricing.js';
import { addUsage, ZERO_USAGE, type LlmUsage } from '../../services/api/src/domain/ports/llm.js';
import { pricingFor } from '../../services/api/src/infrastructure/llm/pricing.js';
import { isSameModel, ServedModelMismatchError } from '../runner/agent-wrappers.js';
import {
  claimsView,
  FAITHFULNESS_JSON_SCHEMA,
  FAITHFULNESS_SYSTEM,
  faithfulnessPrompt,
  FaithfulnessVerdictSchema,
  REQUEST_FIT_JSON_SCHEMA,
  REQUEST_FIT_SYSTEM,
  requestFitPrompt,
  RequestFitVerdictSchema,
  type FaithfulnessVerdict,
  type JudgeInput,
  type RequestFitVerdict,
} from './judge-prompts.js';

/**
 * LLM-as-judge over the Anthropic Messages API with structured outputs. The judge model comes
 * from JUDGE_MODEL and must differ from the agent's model (self-preference). Each property is a
 * separate call; the served model is asserted on every call; usage is costed with the shared
 * price table and reported apart from the agent's cost.
 */

/** The one SDK method the judge uses; injected so tests can fake the judge. */
export interface JudgeMessagesApi {
  create(body: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message>;
}

export interface JudgeOptions {
  readonly messages: JudgeMessagesApi;
  readonly model: string;
  readonly maxTokens?: number;
  readonly effort?: NonNullable<Anthropic.OutputConfig['effort']>;
}

export class JudgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JudgeError';
  }
}

export interface JudgeScores {
  /** Supported claims / claims (null when the candidate makes no factual claim). */
  readonly faithfulness_rate: number | null;
  /** 1 when every claim is supported. */
  readonly faithful: number | null;
  /** Request-fit score scaled to [0, 1] (0, 0.5, 1). */
  readonly request_fit: number | null;
}

export interface JudgeResult {
  readonly scores: JudgeScores;
  readonly faithfulness: FaithfulnessVerdict | null;
  readonly requestFit: RequestFitVerdict | null;
  readonly usage: LlmUsage;
  readonly costUsd: number;
  /** Verdicts decided without a model call (degenerate candidates). */
  readonly shortCircuit: string | null;
}

export interface Judge {
  readonly model: string;
  grade(input: JudgeInput): Promise<JudgeResult>;
}

/** The judge applies to responses with content to grade: itineraries and answers. */
export function isJudgeable(input: JudgeInput): boolean {
  return input.response.type === 'itinerary' || input.response.type === 'answer';
}

export function createJudge(options: JudgeOptions): Judge {
  const pricing = pricingFor(options.model);
  const maxTokens = options.maxTokens ?? 8_000;
  const effort = options.effort ?? 'medium';

  async function call<T>(
    system: string,
    prompt: string,
    schema: Readonly<Record<string, unknown>>,
    parser: z.ZodType<T>,
  ): Promise<{ verdict: T; usage: LlmUsage }> {
    const message = await options.messages.create({
      model: options.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, format: { type: 'json_schema', schema: { ...schema } } },
    });
    if (!isSameModel(options.model, message.model)) {
      throw new ServedModelMismatchError(options.model, message.model);
    }
    const usage: LlmUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    if (message.stop_reason !== 'end_turn') {
      throw new JudgeError(`Judge stopped with ${String(message.stop_reason)}`);
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.join(''));
    } catch (error) {
      throw new JudgeError('Judge output is not JSON', { cause: error });
    }
    const result = parser.safeParse(parsed);
    if (!result.success) throw new JudgeError(`Judge output does not match its schema`);
    return { verdict: result.data, usage };
  }

  return {
    model: options.model,
    async grade(input: JudgeInput): Promise<JudgeResult> {
      if (!isJudgeable(input)) throw new JudgeError(`Cannot judge a ${input.response.type}`);
      if (claimsView(input.response).trim() === '') {
        return {
          scores: { faithfulness_rate: 0, faithful: 0, request_fit: 0 },
          faithfulness: null,
          requestFit: null,
          usage: ZERO_USAGE,
          costUsd: 0,
          shortCircuit: 'empty candidate',
        };
      }
      const faithfulness = await call(
        FAITHFULNESS_SYSTEM,
        faithfulnessPrompt(input),
        FAITHFULNESS_JSON_SCHEMA,
        FaithfulnessVerdictSchema,
      );
      const requestFit = await call(
        REQUEST_FIT_SYSTEM,
        requestFitPrompt(input),
        REQUEST_FIT_JSON_SCHEMA,
        RequestFitVerdictSchema,
      );
      const usage = addUsage(faithfulness.usage, requestFit.usage);
      return {
        scores: scoresOf(faithfulness.verdict, requestFit.verdict),
        faithfulness: faithfulness.verdict,
        requestFit: requestFit.verdict,
        usage,
        costUsd: costUsd(faithfulness.usage, pricing) + costUsd(requestFit.usage, pricing),
        shortCircuit: null,
      };
    },
  };
}

export function scoresOf(
  faithfulness: FaithfulnessVerdict,
  requestFit: RequestFitVerdict,
): JudgeScores {
  const total = faithfulness.claims.length;
  const supported = faithfulness.claims.filter((claim) => claim.supported).length;
  return {
    faithfulness_rate: total === 0 ? null : supported / total,
    faithful: supported === total ? 1 : 0,
    request_fit: requestFit.score / 2,
  };
}

/** A judge over the real SDK client (bounded retries with the SDK's jittered backoff). */
export function createAnthropicJudge(apiKey: string, model: string): Judge {
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  return createJudge({ messages: client.messages, model });
}
