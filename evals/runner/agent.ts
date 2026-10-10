/**
 * Agent evaluation: `npm run eval:agent -w @wanderly/evals [-- options]` (plan section 8,
 * docs/EVALUATIONS.md). Every (case, rep) runs through the production agent loop.
 *
 * Modes:
 * - `real` (default): the configured Claude model (ANTHROPIC_API_KEY), the production Postgres
 *   retriever and knowledge repository on an ingested database (DATABASE_URL), the local
 *   embedding model, and the LLM judge (JUDGE_MODEL) on itineraries and answers.
 * - `oracle`, `null-decline`, `null-empty`: keyless control runs on in-memory ports built from the
 *   corpus files; they check the harness (the oracle must pass, the nulls must fail).
 *
 * Options: --reps N, --cases id,id, --category c,c, --model <agent model>, --judge-model <model>,
 * --no-judge, --max-usd <whole run cap, default 2>, --max-run-usd <per-run agent ceiling>,
 * --concurrency N, --timeout-s <per-case wall clock, default 300>, --gate (exit 1 when a gate
 * fails), --write (real mode: update evals/baselines/agent.json and docs/EVALUATIONS.md).
 *
 * Writes evals/results/<timestamp>-<mode>/: results.jsonl (one scored row per case and rep),
 * errors.jsonl (infrastructure and judge failures, never scored), traces/<case>_rep<k>.json (full
 * trajectory, per-call usage, judge verdicts), summary.json and report.md. In GitHub Actions the
 * report is appended to the job summary.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { agentLimits, createAgentLlm } from '../../services/api/src/composition/agent-deps.js';
import { loadConfig } from '../../services/api/src/config.js';
import { DEFAULT_AGENT_LIMITS } from '../../services/api/src/domain/agent/limits.js';
import { PROMPT_VERSION } from '../../services/api/src/domain/agent/system-prompt.js';
import type { AgentLimits } from '../../services/api/src/domain/agent/types.js';
import type {
  KnowledgeRepository,
  Retriever,
} from '../../services/api/src/domain/ports/knowledge.js';
import { TransformersEmbedder } from '../../services/api/src/infrastructure/embeddings/transformers-embedder.js';
import { FsCorpusSource } from '../../services/api/src/infrastructure/knowledge/fs-corpus-source.js';
import { PgKnowledgeRepository } from '../../services/api/src/infrastructure/knowledge/pg-knowledge-repository.js';
import { PgRetriever } from '../../services/api/src/infrastructure/knowledge/pg-retriever.js';
import { pricingFor } from '../../services/api/src/infrastructure/llm/pricing.js';
import { createAnthropicJudge, isJudgeable, type Judge, type JudgeResult } from '../judge/judge.js';
import { JUDGE_PROMPT_VERSION } from '../judge/judge-prompts.js';
import { renderAgentReport, replaceSection } from '../report/agent-report.js';
import { LOWER_IS_BETTER, scoreRun } from '../scorers/agent-metrics.js';
import { summarizeRun, type ScoredRow } from '../scorers/agent-summary.js';
import type { CASE_CATEGORIES } from './agent-dataset.js';
import {
  CaseCategorySchema,
  findCorpusProblems,
  loadAgentDataset,
  selectCases,
  type AgentCase,
} from './agent-dataset.js';
import {
  evaluateGate,
  evaluateHarnessCheck,
  loadThresholds,
  proposeSoftThresholds,
  type GateResult,
} from './agent-gate.js';
import {
  runAttempt,
  withRetries,
  type AttemptPorts,
  type CaseOutcome,
  type RetriedResult,
} from './agent-harness.js';
import { policyLlm } from './agent-wrappers.js';
import {
  BASELINE_POLICIES,
  baselinePolicy,
  ZERO_PRICING,
  type BaselinePolicy,
} from './baselines.js';
import { InMemoryKnowledge, KeywordRetriever } from './in-memory-knowledge.js';

const EVALS_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = path.resolve(EVALS_DIR, '..');
const DATASET_FILE = path.join(EVALS_DIR, 'datasets', 'agent-cases.yaml');
const THRESHOLDS_FILE = path.join(EVALS_DIR, 'thresholds.json');
const BASELINE_FILE = path.join(EVALS_DIR, 'baselines', 'agent.json');
const EVALUATIONS_DOC = path.join(REPO_DIR, 'docs', 'EVALUATIONS.md');

type Mode = 'real' | BaselinePolicy;

interface Options {
  readonly mode: Mode;
  readonly reps: number;
  readonly ids: string[];
  readonly categories: (typeof CASE_CATEGORIES)[number][];
  readonly model: string | undefined;
  readonly judgeModel: string | undefined;
  readonly judge: boolean;
  readonly maxUsd: number;
  readonly maxRunUsd: number | undefined;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly gate: boolean;
  readonly write: boolean;
  readonly allowSameJudge: boolean;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'real' },
      reps: { type: 'string', default: '1' },
      cases: { type: 'string', default: '' },
      category: { type: 'string', default: '' },
      model: { type: 'string' },
      'judge-model': { type: 'string' },
      'no-judge': { type: 'boolean', default: false },
      'max-usd': { type: 'string', default: '2' },
      'max-run-usd': { type: 'string' },
      concurrency: { type: 'string' },
      'timeout-s': { type: 'string', default: '300' },
      gate: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      'allow-same-judge': { type: 'boolean', default: false },
    },
  });
  const mode = values.mode;
  if (mode !== 'real' && !BASELINE_POLICIES.some((policy) => policy === mode)) {
    throw new Error(`--mode must be real or one of ${BASELINE_POLICIES.join(', ')}`);
  }
  const list = (text: string) =>
    text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  const positive = (name: string, text: string) => {
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`--${name} must be a positive number`);
    return value;
  };
  return {
    mode: mode as Mode,
    reps: Math.floor(positive('reps', values.reps)),
    ids: list(values.cases),
    categories: list(values.category).map((category) => CaseCategorySchema.parse(category)),
    model: values.model,
    judgeModel: values['judge-model'],
    judge: !values['no-judge'],
    maxUsd: positive('max-usd', values['max-usd']),
    maxRunUsd:
      values['max-run-usd'] === undefined
        ? undefined
        : positive('max-run-usd', values['max-run-usd']),
    concurrency: Math.floor(
      positive('concurrency', values.concurrency ?? (mode === 'real' ? '2' : '4')),
    ),
    timeoutMs: positive('timeout-s', values['timeout-s']) * 1000,
    gate: values.gate,
    write: values.write,
    allowSameJudge: values['allow-same-judge'],
  };
}

interface Backend {
  readonly agentModel: string;
  readonly limits: AgentLimits;
  readonly judge: Judge | null;
  ports(testCase: AgentCase): Promise<AttemptPorts>;
  close(): Promise<void>;
}

async function baselineBackend(policy: BaselinePolicy): Promise<Backend> {
  const corpus = await new FsCorpusSource().load();
  const knowledge = new InMemoryKnowledge(corpus);
  const retriever = new KeywordRetriever(corpus);
  return {
    agentModel: policy,
    limits: DEFAULT_AGENT_LIMITS,
    judge: null,
    async ports(testCase) {
      return {
        llm: policyLlm(policy, baselinePolicy(policy, testCase)),
        retriever,
        knowledge,
        pricing: ZERO_PRICING,
        limits: DEFAULT_AGENT_LIMITS,
        canaryToken: canary(),
      };
    },
    close: async () => undefined,
  };
}

async function realBackend(options: Options): Promise<Backend> {
  // Same environment parsing and defaults as the API (SESSION_SECRET only signs API cookies).
  const config = loadConfig({
    ...process.env,
    SESSION_SECRET: process.env['SESSION_SECRET'] ?? randomBytes(32).toString('hex'),
  });
  const apiKey = config.llm.anthropicApiKey?.reveal();
  if (apiKey === undefined) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set: the real agent evaluation needs it (use --mode oracle for a keyless check).',
    );
  }
  const agentModel = options.model ?? config.llm.model;
  const pricing = pricingFor(agentModel);
  const limits = agentLimits({
    llmTimeoutMs: config.llm.timeoutMs,
    runDeadlineMs: config.agent.runDeadlineMs,
    maxSteps: config.agent.maxSteps,
    maxRunCostUsd: options.maxRunUsd ?? config.agent.maxRunCostUsd,
  });
  let judge: Judge | null = null;
  if (options.judge) {
    const judgeModel = options.judgeModel ?? config.llm.judgeModel;
    if (judgeModel === agentModel && !options.allowSameJudge) {
      throw new Error(
        `The judge model (${judgeModel}) must differ from the agent model (self-preference); pass --allow-same-judge to override.`,
      );
    }
    pricingFor(judgeModel);
    judge = createAnthropicJudge(apiKey, judgeModel);
  }
  const pool = new pg.Pool({ connectionString: config.database.url.reveal(), max: 4 });
  const embedder = new TransformersEmbedder({
    model: config.embeddings.model,
    cacheDir: config.embeddings.cacheDir,
  });
  await embedder.load();
  const retriever: Retriever = new PgRetriever(pool, embedder);
  const knowledge: KnowledgeRepository = new PgKnowledgeRepository(pool);
  if ((await knowledge.listDestinations()).length === 0) {
    await pool.end();
    throw new Error(
      'The knowledge base is empty: run `npm run migrate` and `npm run ingest` first.',
    );
  }
  const warn = (details: Record<string, unknown>, message: string) =>
    console.warn(message, details);
  return {
    agentModel,
    limits,
    judge,
    async ports() {
      return {
        // A fresh adapter per attempt: no client state shared between (case, rep).
        llm: createAgentLlm(
          { apiKey, model: agentModel, effort: config.llm.effort, timeoutMs: config.llm.timeoutMs },
          warn,
        ),
        retriever,
        knowledge,
        pricing,
        limits,
        canaryToken: canary(),
      };
    },
    close: () => pool.end(),
  };
}

function canary(): string {
  return `wanderly-eval-canary-${randomBytes(12).toString('hex')}`;
}

interface Job {
  readonly testCase: AgentCase;
  readonly rep: number;
}

interface ErrorRow {
  readonly caseId: string;
  readonly rep: number;
  readonly attempt: number | null;
  readonly class: string;
  readonly message: string;
  readonly final: boolean;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const dataset = await loadAgentDataset(DATASET_FILE);
  const problems = findCorpusProblems(dataset, await new FsCorpusSource().load());
  if (problems.length > 0)
    throw new Error(`Dataset does not match the corpus:\n  ${problems.join('\n  ')}`);
  const cases = selectCases(dataset, { ids: options.ids, categories: options.categories });
  if (cases.length === 0) throw new Error('No case selected');
  if (options.write && options.mode !== 'real') throw new Error('--write is only for real runs');

  const thresholds = await loadThresholds(THRESHOLDS_FILE);
  const backend =
    options.mode === 'real' ? await realBackend(options) : await baselineBackend(options.mode);
  const startedAt = new Date();
  const outDir = path.join(
    EVALS_DIR,
    'results',
    `${startedAt.toISOString().replace(/[:.]/g, '-')}-${options.mode}`,
  );
  await mkdir(path.join(outDir, 'traces'), { recursive: true });
  console.log(
    `${cases.length} case(s) × ${options.reps} rep(s), mode ${options.mode}, agent ${backend.agentModel}, judge ${backend.judge?.model ?? 'off'}, cap $${options.maxUsd}`,
  );

  const rows: ScoredRow[] = [];
  const errors: ErrorRow[] = [];
  let spentUsd = 0;
  let inFlight = 0;
  let abortedReason: string | null = null;
  let skipped = 0;
  const jobs: Job[] = cases.flatMap((testCase) =>
    Array.from({ length: options.reps }, (_, index) => ({ testCase, rep: index + 1 })),
  );

  const runJob = async ({ testCase, rep }: Job): Promise<void> => {
    // Budget: never start a case whose worst case could cross the cap with what is in flight.
    const worstCase = backend.limits.maxRunCostUsd * testCase.turns.length;
    if (abortedReason !== null || spentUsd + (inFlight + 1) * worstCase > options.maxUsd) {
      abortedReason ??= `budget cap of $${options.maxUsd} reached (spent $${spentUsd.toFixed(4)})`;
      skipped += 1;
      errors.push({
        caseId: testCase.id,
        rep,
        attempt: null,
        class: 'skipped_budget',
        message: abortedReason,
        final: true,
      });
      return;
    }
    inFlight += 1;
    try {
      const retried = await withRetries(async () =>
        runAttempt(testCase, await backend.ports(testCase), {
          today: dataset.today,
          ceilingMs: options.timeoutMs,
        }),
      );
      spentUsd += retried.spentUsd;
      retried.failures.forEach((failure, index) =>
        errors.push({
          caseId: testCase.id,
          rep,
          attempt: index + 1,
          class: failure.failure,
          message: failure.message,
          final: retried.final.kind === 'infra' && index === retried.failures.length - 1,
        }),
      );
      if (retried.final.kind !== 'scored') return;
      const row = await scoreAndJudge(testCase, rep, retried, retried.final.outcome);
      spentUsd += row.judgeCostUsd;
      rows.push(row);
      process.stdout.write(`${row.status === 'ok' ? '.' : row.status[0]}`);
    } finally {
      inFlight -= 1;
    }
  };

  const scoreAndJudge = async (
    testCase: AgentCase,
    rep: number,
    retried: RetriedResult,
    outcome: CaseOutcome,
  ): Promise<ScoredRow> => {
    const scores = scoreRun(testCase, outcome.observation, { canaryToken: outcome.canaryToken });
    let judged: JudgeResult | null = null;
    let judgeError: string | null = null;
    const response = outcome.observation.response;
    if (backend.judge !== null && response !== null) {
      const input = {
        userTurns: testCase.turns,
        response,
        retrievedContext: retrievedContext(outcome),
      };
      if (isJudgeable(input)) {
        try {
          judged = await backend.judge.grade(input);
        } catch (error) {
          judgeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          errors.push({
            caseId: testCase.id,
            rep,
            attempt: null,
            class: 'judge_error',
            message: judgeError,
            final: true,
          });
        }
      }
    }
    const row: ScoredRow = {
      caseId: testCase.id,
      category: testCase.category,
      rep,
      status: outcome.observation.status,
      scores,
      judge: judged === null ? {} : { ...judged.scores },
      costUsd: outcome.costUsd,
      judgeCostUsd: judged?.costUsd ?? 0,
      latencyMs: outcome.latencyMs,
      steps: outcome.steps,
      attempts: retried.attempts,
    };
    await writeFile(
      path.join(outDir, 'traces', `${testCase.id}_rep${rep}.json`),
      JSON.stringify(
        {
          case: testCase,
          rep,
          attempts: retried.attempts,
          status: outcome.observation.status,
          failureReason: outcome.observation.failureReason,
          servedModels: [...new Set(outcome.llmCalls.map((call) => call.model))],
          scores,
          judge: judged === null ? { error: judgeError } : judged,
          usage: outcome.usage,
          costUsd: outcome.costUsd,
          latencyMs: outcome.latencyMs,
          llmCalls: outcome.llmCalls,
          toolCalls: outcome.toolCalls,
          turns: outcome.turns,
        },
        null,
        1,
      ),
    );
    await appendFile(
      path.join(outDir, 'results.jsonl'),
      `${JSON.stringify({ ...row, failureReason: outcome.observation.failureReason })}\n`,
    );
    return row;
  };

  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) await runJob(job);
    }),
  );
  process.stdout.write('\n');
  await backend.close();
  if (errors.length > 0) {
    await writeFile(
      path.join(outDir, 'errors.jsonl'),
      errors.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  }

  const summary = summarizeRun(rows);
  const finalFailures = errors.filter((row) => row.final && row.class !== 'judge_error').length;
  const scoredFraction = rows.length / Math.max(1, rows.length + finalFailures);
  const gates: { title: string; result: GateResult }[] = [];
  if (options.mode === 'real') {
    gates.push({
      title: 'Quality gate',
      result: evaluateGate(summary, thresholds, { scoredFraction }),
    });
  } else {
    gates.push({
      title: `Harness check: the ${options.mode} control ${options.mode === 'oracle' ? 'must score near 100 %' : 'must score low'}`,
      result: evaluateHarnessCheck(summary, thresholds, options.mode),
    });
  }
  const infraFailures: Record<string, number> = {};
  for (const row of errors) infraFailures[row.class] = (infraFailures[row.class] ?? 0) + 1;
  const gitSha = currentSha();
  const command =
    `npm run eval:agent -w @wanderly/evals -- ${process.argv.slice(2).join(' ')}`.trim();
  const report = renderAgentReport(
    {
      generatedAt: startedAt.toISOString(),
      mode: options.mode,
      agentModel: backend.agentModel,
      judgeModel: backend.judge?.model ?? null,
      promptVersion: PROMPT_VERSION,
      gitSha,
      command,
      infraFailures,
      abortedReason,
    },
    summary,
    gates,
  );
  const proposals =
    options.mode === 'real'
      ? proposeSoftThresholds(summary, thresholds, LOWER_IS_BETTER, startedAt.toISOString())
      : {};
  const summaryJson = {
    generatedAt: startedAt.toISOString(),
    mode: options.mode,
    agentModel: backend.agentModel,
    judgeModel: backend.judge?.model ?? null,
    promptVersion: PROMPT_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    gitSha,
    datasetCases: cases.length,
    reps: options.reps,
    skipped,
    abortedReason,
    scoredFraction,
    spentUsd,
    summary,
    gates,
    proposedSoftThresholds: proposals,
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summaryJson, null, 2));
  await writeFile(path.join(outDir, 'report.md'), `${report}\n`);
  console.log(`\n${report}\n\nResults: ${path.relative(REPO_DIR, outDir)}`);
  const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
  if (stepSummary)
    await appendFile(stepSummary, `## Agent evaluation (${options.mode})\n\n${report}\n\n`);

  if (options.write) {
    await writeFile(BASELINE_FILE, `${JSON.stringify(summaryJson, null, 2)}\n`);
    const document = await readFile(EVALUATIONS_DOC, 'utf8');
    await writeFile(EVALUATIONS_DOC, replaceSection(document, report));
    console.log(
      `Updated ${path.relative(REPO_DIR, BASELINE_FILE)} and ${path.relative(REPO_DIR, EVALUATIONS_DOC)}`,
    );
  }

  const failed = gates.some((gate) => gate.result.verdict === 'fail');
  if (failed && (options.gate || options.mode !== 'real')) process.exitCode = 1;
}

/** Excerpts, POIs, weather and budget the agent received in the graded turn. */
function retrievedContext(outcome: CaseOutcome): string[] {
  const last = outcome.turns.at(-1);
  if (last === undefined) return [];
  return last.messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((block) =>
          block.type === 'tool_result' && !block.isError ? [block.content] : [],
        )
      : [],
  );
}

function currentSha(): string | null {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'];
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
