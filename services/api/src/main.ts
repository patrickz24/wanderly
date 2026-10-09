import { buildApp, type App } from './app.js';
import { createReadinessProbe } from './application/readiness.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { listMigrationNames } from './infrastructure/db/migration-files.js';
import { createPool } from './infrastructure/db/pool.js';
import {
  createDatabaseCheck,
  createMigrationsCheck,
} from './infrastructure/db/readiness-checks.js';

/** Upper bound for a graceful shutdown before the process is forced to exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Composition root: the only place where configuration and adapters are wired together. */
async function main(): Promise<void> {
  const config = loadConfigOrExit();

  const pool = createPool({
    url: config.database.url,
    // Clients only exist once requests are served, so `app` is initialized by then.
    onIdleClientError: (error) => app.log.error({ err: error }, 'idle Postgres client error'),
  });

  const readinessProbe = createReadinessProbe([
    createDatabaseCheck(pool),
    createMigrationsCheck(pool, await listMigrationNames()),
  ]);

  const app: App = await buildApp({ config, readinessProbe });

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
      // Stop accepting connections and drain in-flight requests, then release the database.
      await app.close();
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
