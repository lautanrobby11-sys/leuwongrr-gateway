import { loadConfig } from './config.js';
import { createLogger } from './observability.js';
import { GatewayDatabase } from './persistence/database.js';
import { OmniRouteClient } from './upstream.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = new GatewayDatabase(config.DATABASE_PATH, config.API_KEY_PEPPER, {
  cacheKib: config.SQLITE_CACHE_KIB
});
const upstream = new OmniRouteClient(
  config.OMNIROUTE_URL,
  config.UPSTREAM_CONCURRENCY,
  config.REQUEST_TIMEOUT_MS
);
const app = buildApp({ config, db, upstream, logger });

let stopping = false;

function runMaintenance(): void {
  try {
    const result = db.maintain(config.RETENTION_DAYS);
    logger.info({ ...result, retentionDays: config.RETENTION_DAYS }, 'maintenance_completed');
  } catch (error) {
    logger.error({ err: error }, 'maintenance_failed');
  }
}

const maintenanceTimer = setInterval(runMaintenance, config.MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'graceful shutdown');
  clearInterval(maintenanceTimer);
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
  runMaintenance();
  await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
  logger.info(
    {
      host: config.GATEWAY_HOST,
      port: config.GATEWAY_PORT,
      upstream: config.OMNIROUTE_URL,
      concurrency: config.UPSTREAM_CONCURRENCY,
      rateLimitRpm: config.RATE_LIMIT_RPM,
      retentionDays: config.RETENTION_DAYS
    },
    'gateway_listening'
  );
} catch (error) {
  logger.fatal({ err: error }, 'listen_failed');
  db.close();
  process.exit(1);
}
