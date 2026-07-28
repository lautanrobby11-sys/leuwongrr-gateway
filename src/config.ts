import { z } from 'zod';

const loopbackUrl = z.string().url().refine((value) => {
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
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace','silent']).default('info'),
  UPSTREAM_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  DAILY_BUDGET_UNITS: z.coerce.number().int().positive().default(100000)
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
