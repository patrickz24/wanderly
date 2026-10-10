import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp, type App } from './app.js';
import {
  createCreateConversation,
  createGetConversation,
  createListConversations,
} from './application/conversations.js';
import type { IdGenerator } from './application/ports/system.js';
import { createReadinessProbe } from './application/readiness.js';
import { createSendMessage } from './application/send-message.js';
import { createSubmitFeedback } from './application/submit-feedback.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { DEFAULT_AGENT_LIMITS } from './domain/agent/limits.js';
import { runAgent } from './domain/agent/run-agent.js';
import type { AgentLimits } from './domain/agent/types.js';
import { ProviderUnavailableError } from './domain/errors.js';
import type { LlmPort } from './domain/ports/llm.js';
import { NOOP_TRACER, SYSTEM_CLOCK, type Tracer } from './domain/ports/tracer.js';
import { listMigrationNames } from './infrastructure/db/migration-files.js';
import { createPool } from './infrastructure/db/pool.js';
import {
  createDatabaseCheck,
  createMigrationsCheck,
} from './infrastructure/db/readiness-checks.js';
import {
  TransformersEmbedder,
  createEmbedderReadinessCheck,
} from './infrastructure/embeddings/transformers-embedder.js';
import { PgKnowledgeRepository } from './infrastructure/knowledge/pg-knowledge-repository.js';
import { PgRetriever } from './infrastructure/knowledge/pg-retriever.js';
import { ANTHROPIC_PROVIDER, createAnthropicLlm } from './infrastructure/llm/anthropic-llm.js';
import { pricingFor } from './infrastructure/llm/pricing.js';
import { createPgPersistence } from './infrastructure/persistence/index.js';
import { startLangfuseTracing } from './infrastructure/tracing/langfuse-tracer.js';

/** Upper bound for a graceful shutdown before the process is forced to exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const UUIDS: IdGenerator = { newId: () => randomUUID() };

/** Composition root: the only place where configuration and adapters are wired together. */
async function main(): Promise<void> {
  const config = loadConfigOrExit();
  // Adapters log through the app's logger: `app` is initialized before any request or background
  // error can reach these callbacks.
  const log = (): FastifyBaseLogger => app.log;

  const pool = createPool({
    url: config.database.url,
    onIdleClientError: (error) => log().error({ err: error }, 'idle Postgres client error'),
  });
  const persistence = createPgPersistence(pool);

  const embedder = new TransformersEmbedder({
    model: config.embeddings.model,
    cacheDir: config.embeddings.cacheDir,
  });
  const tracing = startTracing(config, (error, operation) =>
    log().warn({ err: error, operation }, 'tracing failed'),
  );

  const readinessProbe = createReadinessProbe([
    createDatabaseCheck(pool),
    createMigrationsCheck(pool, await listMigrationNames()),
    createEmbedderReadinessCheck(embedder),
  ]);

  const tracer: Tracer = tracing?.tracer ?? NOOP_TRACER;
  const conversationDeps = {
    conversations: persistence.conversations,
    ids: UUIDS,
    clock: SYSTEM_CLOCK,
  };
  const app: App = await buildApp({
    config,
    readinessProbe,
    api: {
      useCases: {
        createConversation: createCreateConversation(conversationDeps),
        listConversations: createListConversations(conversationDeps),
        getConversation: createGetConversation(conversationDeps),
        sendMessage: createSendMessage({
          conversations: persistence.conversations,
          runs: persistence.runs,
          unitOfWork: persistence.unitOfWork,
          ledger: persistence.ledger,
          agent: {
            runAgent,
            llm: createLlm(config, (details, message) => log().warn(details, message)),
            retriever: new PgRetriever(pool, embedder),
            knowledge: new PgKnowledgeRepository(pool),
            limits: agentLimits(config),
            pricing: pricingFor(config.llm.model),
            canaryToken: config.agent.canaryToken.reveal(),
          },
          tracer,
          clock: SYSTEM_CLOCK,
          ids: UUIDS,
          dailyBudgetUsd: config.budget.dailyUsd,
          traceTags: ['api', config.env],
        }),
        submitFeedback: createSubmitFeedback({
          runs: persistence.runs,
          feedback: persistence.feedback,
          tracer,
          clock: SYSTEM_CLOCK,
        }),
      },
    },
  });

  if (config.llm.anthropicApiKey === undefined) {
    app.log.warn('ANTHROPIC_API_KEY is not set: agent runs will fail as provider unavailable');
  }
  app.log.info({ enabled: tracing !== undefined }, 'Langfuse tracing');
  // Loaded in the background: /health answers at once, /ready waits for the model.
  embedder
    .load()
    .then(() => app.log.info({ model: embedder.model }, 'embedding model loaded'))
    .catch((error: unknown) => app.log.error({ err: error }, 'embedding model failed to load'));

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      app.log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    let code = exitCode;
    try {
      // Stop accepting connections and drain in-flight requests (their runs are recorded),
      // then send the buffered traces and scores, then release the database.
      await app.close();
      await tracing?.shutdown();
      await pool.end();
      app.log.info('shutdown complete');
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      code = 1;
    }
    clearTimeout(forceExit);
    process.exit(code);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  // A rejection nobody handled leaves the process in an unknown state: log it and restart cleanly.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  await app.listen({ host: config.server.host, port: config.server.port });
}

/** Run limits: the runtime's defaults, with the deadlines and budgets set by configuration. */
function agentLimits(config: Config): AgentLimits {
  return {
    ...DEFAULT_AGENT_LIMITS,
    llmTimeoutMs: config.llm.timeoutMs,
    runDeadlineMs: config.agent.runDeadlineMs,
    maxSteps: config.agent.maxSteps,
    ...(config.agent.maxRunCostUsd === undefined
      ? {}
      : { maxRunCostUsd: config.agent.maxRunCostUsd }),
  };
}

/**
 * The Anthropic adapter, or, without an API key, a port that fails every call as "provider
 * unavailable" without any network access: the rest of the API (conversations, history,
 * feedback) keeps working and runs end with a clear error event.
 */
function createLlm(
  config: Config,
  warn: (details: Record<string, unknown>, message: string) => void,
): LlmPort {
  const apiKey = config.llm.anthropicApiKey;
  if (apiKey === undefined) {
    return {
      provider: ANTHROPIC_PROVIDER,
      model: config.llm.model,
      generate: () => Promise.reject(new ProviderUnavailableError(ANTHROPIC_PROVIDER)),
    };
  }
  return createAnthropicLlm({
    apiKey: apiKey.reveal(),
    model: config.llm.model,
    effort: config.llm.effort,
    timeoutMs: config.llm.timeoutMs,
    logger: { warn },
  });
}

/** Langfuse when both keys are set; otherwise tracing is a no-op. */
function startTracing(
  config: Config,
  onError: (error: unknown, operation: string) => void,
): ReturnType<typeof startLangfuseTracing> | undefined {
  const { publicKey, secretKey, baseUrl } = config.langfuse;
  if (publicKey === undefined || secretKey === undefined) return undefined;
  return startLangfuseTracing({
    publicKey,
    secretKey: secretKey.reveal(),
    baseUrl,
    environment: config.env,
    onError,
  });
}

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
