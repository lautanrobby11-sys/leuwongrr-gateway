import { loadConfig } from './config.js';
import { createLogger } from './observability.js';
import { GatewayDatabase } from './persistence/database.js';
import { OmniRouteClient } from './upstream.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = new GatewayDatabase(config.DATABASE_PATH, config.API_KEY_PEPPER);
const upstream = new OmniRouteClient(
  config.OMNIROUTE_URL,
  config.UPSTREAM_CONCURRENCY,
  config.REQUEST_TIMEOUT_MS
);
const app = buildApp({ config, db, upstream, logger });

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'graceful shutdown');
  const deadline = setTimeout(() => process.exit(1), 15_000).unref();
  try {
    await app.close();
    db.close();
  } finally {
    clearTimeout(deadline);
  }
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled_rejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught_exception');
  void shutdown('uncaughtException').finally(() => process.exit(1));
});

try {
  await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
  logger.info(
    {
      host: config.GATEWAY_HOST,
      port: config.GATEWAY_PORT,
      upstream: config.OMNIROUTE_URL,
      concurrency: config.UPSTREAM_CONCURRENCY
    },
    'gateway_listening'
  );
} catch (error) {
  logger.fatal({ err: error }, 'listen_failed');
  db.close();
  process.exit(1);
}
