import { z } from 'zod';

const loopbackUrl = z
  .string()
  .url()
  .refine((value) => {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }, 'must target loopback');

const schema = z.object({
  GATEWAY_HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  GATEWAY_PORT: z.coerce.number().int().min(1024).max(65535).default(2080),
  OMNIROUTE_URL: loopbackUrl.default('http://127.0.0.1:20128'),
  DATABASE_PATH: z.string().min(1).default('./data/gateway.db'),
  API_KEY_PEPPER: z.string().min(32),
  INTERNAL_READY_TOKEN: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UPSTREAM_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  DAILY_BUDGET_UNITS: z.coerce.number().int().positive().default(100000),
  RATE_LIMIT_RPM: z.coerce.number().int().min(1).max(100000).default(120),
  RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100000).default(30),
  RATE_LIMIT_MAX_ENTRIES: z.coerce.number().int().min(64).max(100000).default(2048),
  STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  SQLITE_CACHE_KIB: z.coerce.number().int().min(256).max(65536).default(4096),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60000).max(86400000).default(3600000),
  /**
   * Every request arrives from cloudflared over loopback, so the socket peer is
   * useless for fairness. The forwarded header is only honoured when the
   * operator opts in and the peer really is the local tunnel.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TRUSTED_CLIENT_IP_HEADER: z.string().min(1).max(64).default('cf-connecting-ip'),
  READY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(200).max(30000).default(2000),
  TENANT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(2),
  TENANT_LIMIT_MAX_ENTRIES: z.coerce.number().int().min(16).max(100000).default(512)
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.RATE_LIMIT_BURST > config.RATE_LIMIT_RPM) {
    throw new Error('RATE_LIMIT_BURST must not exceed RATE_LIMIT_RPM');
  }
  if (config.TENANT_MAX_CONCURRENT > config.UPSTREAM_CONCURRENCY) {
    throw new Error('TENANT_MAX_CONCURRENT must not exceed UPSTREAM_CONCURRENCY');
  }
  return config;
}
