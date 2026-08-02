import Fastify, {
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { allowedConsoleOrigins, type Config } from '../config.js';
import {
  bearerToken,
  requireScope,
  AuthError,
  type ApiKeyRecord,
  type Scope
} from '../auth/api-keys.js';
import { chatRequestSchema } from '../contracts/chat.js';
import { responsesRequestSchema } from '../contracts/responses.js';
import { countTokensRequestSchema, messagesRequestSchema } from '../contracts/messages.js';
import { sendProtocolError, type Dialect } from '../contracts/errors.js';
import {
  listModels,
  requireModel,
  PolicyError,
  type Capability,
  type ModelPolicy
} from '../policy/capabilities.js';
import { isConsoleRoute, requiresTrustedOrigin, resolveRoute } from '../policy/allowlist.js';
import { MetricsRegistry } from '../metrics.js';
import { OverloadError } from '../policy/semaphore.js';
import { TokenBucketLimiter, RateLimitError } from '../policy/rate-limit.js';
import { TenantConcurrencyRegistry, TenantRateLimiterRegistry } from '../policy/tenant-limits.js';
import type { GatewayDatabase } from '../persistence/database.js';
import type { OmniRouteClient } from '../upstream.js';
import { createUpstreamExecutor } from './pipeline.js';
import { registerConsole } from './console.js';
import { AccountStore } from '../accounts/store.js';
import { AccessVerifier } from '../accounts/access.js';
import { BillingError, BillingService } from '../billing/service.js';
import { CryptomusClient } from '../payments/cryptomus.js';
import type { Logger } from 'pino';

export interface AppDeps {
  config: Config;
  db: GatewayDatabase;
  upstream: OmniRouteClient;
  logger: Logger;
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CLIENT_IP_PATTERN = /^[0-9a-fA-F:.]{3,45}$/;
const DEFAULT_MAX_TOKENS = 1024;

export function clientIdentity(req: FastifyRequest, config: Config): string {
  if (!config.TRUST_PROXY) return req.ip;
  const peer = req.socket.remoteAddress ?? req.ip;
  if (!LOOPBACK_PEERS.has(peer)) return req.ip;
  const raw = req.headers[config.TRUSTED_CLIENT_IP_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return req.ip;
  const candidate = value.split(',')[0]?.trim() ?? '';
  return CLIENT_IP_PATTERN.test(candidate) ? candidate : req.ip;
}

function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
}

/** Comparison whose duration does not depend on how much of the token matched. */
function tokenMatches(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The origin a browser attributes the request to. Referer is accepted as a
 * fallback because a few privacy configurations strip Origin from same-site
 * form posts, but an unparseable or absent value stays null and is refused.
 */
function requestOrigin(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export function buildApp(deps: AppDeps) {
  // Fastify consumes the documented base logger contract. Pino's concrete
  // Logger is structurally compatible, but exposing its wider generic here
  // makes plugin registration invariant and rejects otherwise valid plugins.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    requestTimeout: deps.config.REQUEST_TIMEOUT_MS,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    disableRequestLogging: true
  });

  const metrics = new MetricsRegistry();
  const consoleOrigins = allowedConsoleOrigins(deps.config);

  const sourceLimiter = new TokenBucketLimiter(
    deps.config.RATE_LIMIT_RPM * 2,
    deps.config.RATE_LIMIT_BURST * 2,
    deps.config.RATE_LIMIT_MAX_ENTRIES
  );
  const credentialLimiter = new TokenBucketLimiter(
    deps.config.RATE_LIMIT_RPM,
    deps.config.RATE_LIMIT_BURST,
    deps.config.RATE_LIMIT_MAX_ENTRIES
  );
  /**
   * A console page load fetches its HTML plus several hashed assets, so charging
   * the shell to the data-plane bucket lets opening the dashboard exhaust the
   * caller's budget for /v1/*. Static delivery gets its own, wider bucket —
   * still bounded, because an unmetered static path is a free amplifier.
   */
  const consoleShellLimiter = new TokenBucketLimiter(
    deps.config.RATE_LIMIT_RPM * 20,
    deps.config.RATE_LIMIT_BURST * 20,
    deps.config.RATE_LIMIT_MAX_ENTRIES
  );
  const tenantLimiter = new TenantRateLimiterRegistry(
    deps.config.TENANT_LIMIT_MAX_ENTRIES,
    deps.config.RATE_LIMIT_BURST
  );
  const tenantConcurrency = new TenantConcurrencyRegistry(deps.config.TENANT_LIMIT_MAX_ENTRIES);

  const accounts = new AccountStore(deps.db.db, deps.config.API_KEY_PEPPER);
  const billing = new BillingService(deps.db.db);
  const execute = createUpstreamExecutor({
    config: deps.config,
    db: deps.db,
    upstream: deps.upstream,
    tenantConcurrency,
    onError: handleError
  });

  if (deps.config.CONSOLE_ENABLED) {
    registerConsole(app, {
      config: deps.config,
      db: deps.db,
      accounts,
      billing,
      payments: new CryptomusClient(deps.config),
      access:
        deps.config.ACCESS_TEAM_DOMAIN && deps.config.ACCESS_AUD
          ? new AccessVerifier(deps.config.ACCESS_TEAM_DOMAIN, deps.config.ACCESS_AUD)
          : null,
      logger: deps.logger
    });
    const sweep = setInterval(() => {
      try {
        accounts.maintain();
      } catch (error) {
        deps.logger.error({ err: error }, 'console_maintenance_failed');
      }
    }, deps.config.MAINTENANCE_INTERVAL_MS);
    sweep.unref();
    app.addHook('onClose', async () => clearInterval(sweep));
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const route = resolveRoute(req.method, path);
    // Headers first, so a rejected request carries the same trace id and
    // hardening headers as an accepted one. Previously an unlisted path answered
    // the envelope with none of them, while an allowlisted-but-unregistered path
    // answered with the headers and Fastify's own body.
    reply
      .header('x-request-id', req.id)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'same-origin');
    if (!route) {
      return sendProtocolError(reply, 'openai', 404, 'route_not_found', 'Route is not available', req.id);
    }
    // The console family is allowlisted unconditionally but only registered when
    // CONSOLE_ENABLED is true. Without this branch every console path — the apex
    // included — fell through to Fastify's default handler and answered
    // `{"message":"Route GET:/ not found",...}` instead of the gateway envelope,
    // which is the shape production returns today.
    if (!deps.config.CONSOLE_ENABLED && isConsoleRoute(route)) {
      return sendProtocolError(reply, 'openai', 404, 'route_not_found', 'Route is not available', req.id);
    }
    if (route === 'health.live' || route === 'health.ready') return;
    if (route === 'console.asset') reply.removeHeader('cache-control');
    // Only the static shell moves to the wider bucket. Every state-changing
    // console surface, the OTP request path included, stays on the data-plane
    // limiter.
    const limiter =
      route === 'console.page' || route === 'console.asset' ? consoleShellLimiter : sourceLimiter;
    const decision = limiter.consume(clientIdentity(req, deps.config));
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      if (isConsoleRoute(route)) {
        return reply
          .code(429)
          .send({ error: { code: 'rate_limited', message: 'Too many requests', trace_id: req.id } });
      }
      return sendProtocolError(reply, 'openai', 429, 'rate_limited', 'Too many requests', req.id, true);
    }
    // Cookie and edge-assertion authority is attached by the browser on its
    // own, so a state change needs proof the caller is our own page. Checked
    // here rather than per handler: a route cannot forget a shared hook.
    if (req.method === 'POST' && requiresTrustedOrigin(route)) {
      const origin = requestOrigin(req);
      if (origin === null || !consoleOrigins.has(origin)) {
        return reply.code(403).send({
          error: { code: 'origin_rejected', message: 'Origin is not allowed', trace_id: req.id }
        });
      }
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const route = resolveRoute(req.method, path);
    if (!route) return;
    metrics.observe(route, reply.statusCode, reply.elapsedTime);
  });

  async function authenticate(req: FastifyRequest, scope: Scope): Promise<ApiKeyRecord> {
    const token = bearerToken(req.headers.authorization);
    const record = token ? deps.db.authenticate(token) : null;
    if (!record) throw new AuthError('invalid_api_key', 401);
    requireScope(record, scope);
    const decision = credentialLimiter.consume(record.keyHash);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
    const limits = deps.db.tenants.limits(record.tenantId);
    const tenantDecision = tenantLimiter.consume(
      record.tenantId,
      limits?.rateLimitRpm ?? deps.config.RATE_LIMIT_RPM
    );
    if (!tenantDecision.allowed) throw new RateLimitError(tenantDecision.retryAfterSeconds);
    assertFunded(record.tenantId);
    return record;
  }

  function assertFunded(tenantId: string): void {
    if (!deps.config.CONSOLE_ENABLED) return;
    const account = accounts.findByTenant(tenantId);
    if (!account) return;
    if (account.status !== 'active') throw new PolicyError('account_suspended', 403);
    try {
      billing.assertFunded(account.id, tenantId);
    } catch (error) {
      if (error instanceof BillingError) throw new PolicyError(error.code, error.statusCode);
      throw error;
    }
  }

  function resolveModel(
    publicId: string,
    required: readonly Capability[],
    tenantId: string
  ): ModelPolicy {
    const model = requireModel(publicId, required);
    if (!deps.db.modelEnabled(tenantId, model.publicId)) {
      throw new PolicyError('model_not_entitled', 403);
    }
    return model;
  }

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (req, reply) => {
    if (!tokenMatches(req.headers['x-internal-ready-token'], deps.config.INTERNAL_READY_TOKEN)) {
      return sendProtocolError(reply, 'openai', 404, 'route_not_found', 'Route is not available', req.id);
    }
    try {
      deps.db.db.prepare('SELECT 1').get();
    } catch {
      return sendProtocolError(reply, 'openai', 503, 'not_ready', 'Dependency unavailable', req.id, true);
    }
    try {
      const probe = await deps.upstream.request(
        '/api/monitoring/health',
        { method: 'GET', headers: { 'x-request-id': req.id } },
        AbortSignal.timeout(deps.config.READY_UPSTREAM_TIMEOUT_MS)
      );
      await probe.body?.cancel();
      if (!probe.ok) {
        return sendProtocolError(reply, 'openai', 503, 'not_ready', 'Upstream unavailable', req.id, true);
      }
    } catch {
      return sendProtocolError(reply, 'openai', 503, 'not_ready', 'Upstream unavailable', req.id, true);
    }
    return { status: 'ready' };
  });

  /**
   * Answers as if it did not exist unless the operator both enabled it and
   * presented the dedicated token, so a scrape port that is accidentally
   * reachable still reveals nothing. It stays subject to the source rate limit
   * so the token cannot be guessed at speed.
   */
  app.get('/metrics', async (req, reply) => {
    if (
      !deps.config.METRICS_ENABLED ||
      !tokenMatches(req.headers['x-internal-metrics-token'], deps.config.INTERNAL_METRICS_TOKEN)
    ) {
      return sendProtocolError(reply, 'openai', 404, 'route_not_found', 'Route is not available', req.id);
    }
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.render());
  });

  app.get('/v1/models', async (req, reply) => {
    try {
      const key = await authenticate(req, 'models:read');
      return {
        object: 'list',
        data: listModels()
          .filter((model) => deps.db.modelEnabled(key.tenantId, model.publicId))
          .map((model) => ({
            id: model.publicId,
            object: 'model',
            owned_by: 'leuwongrr',
            capabilities: [...model.capabilities]
          }))
      };
    } catch (error) {
      return handleError(error, reply, req.id, 'openai');
    }
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    let key: ApiKeyRecord;
    try {
      key = await authenticate(req, 'chat:write');
    } catch (error) {
      return handleError(error, reply, req.id, 'openai');
    }
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendProtocolError(reply, 'openai', 400, 'invalid_request', 'Request body failed schema validation', req.id);
    }
    const required: Capability[] = ['text'];
    if (parsed.data.tools?.length) required.push('tools');
    if (parsed.data.stream) required.push('stream');
    let model: ModelPolicy;
    try {
      model = resolveModel(parsed.data.model, required, key.tenantId);
    } catch (error) {
      return handleError(error, reply, req.id, 'openai');
    }
    const maxTokens = Math.min(
      parsed.data.max_tokens ?? parsed.data.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
      model.maxOutputTokens
    );
    return execute(req, reply, key, {
      dialect: 'openai',
      upstreamPath: '/v1/chat/completions',
      body: {
        ...parsed.data,
        model: model.upstreamModel,
        max_tokens: maxTokens,
        max_completion_tokens: undefined,
        stream_options: parsed.data.stream
          ? { ...parsed.data.stream_options, include_usage: true }
          : parsed.data.stream_options
      },
      stream: parsed.data.stream,
      model: parsed.data.model,
      estimateUnits:
        Math.ceil(maxTokens + JSON.stringify(parsed.data.messages).length / 4) +
        deps.config.UPSTREAM_CONTEXT_OVERHEAD_UNITS,
      auditEvent: 'llm.request',
      auditStreamEvent: 'llm.stream.completed'
    });
  });

  app.post('/v1/responses', async (req, reply) => {
    let key: ApiKeyRecord;
    try {
      key = await authenticate(req, 'responses:write');
    } catch (error) {
      return handleError(error, reply, req.id, 'openai');
    }
    const parsed = responsesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendProtocolError(reply, 'openai', 400, 'invalid_request', 'Request body failed schema validation', req.id);
    }
    const required: Capability[] = ['text'];
    if (parsed.data.tools?.length) required.push('tools');
    if (parsed.data.stream) required.push('stream');
    let model: ModelPolicy;
    try {
      model = resolveModel(parsed.data.model, required, key.tenantId);
    } catch (error) {
      return handleError(error, reply, req.id, 'openai');
    }
    const maxTokens = Math.min(parsed.data.max_output_tokens ?? DEFAULT_MAX_TOKENS, model.maxOutputTokens);
    return execute(req, reply, key, {
      dialect: 'openai',
      upstreamPath: '/v1/responses',
      body: { ...parsed.data, model: model.upstreamModel, max_output_tokens: maxTokens },
      stream: parsed.data.stream,
      model: parsed.data.model,
      estimateUnits:
        Math.ceil(maxTokens + (textLength(parsed.data.input) + textLength(parsed.data.instructions)) / 4) +
        deps.config.UPSTREAM_CONTEXT_OVERHEAD_UNITS,
      auditEvent: 'llm.responses.request',
      auditStreamEvent: 'llm.responses.stream.completed'
    });
  });

  app.post('/v1/messages', async (req, reply) => {
    let key: ApiKeyRecord;
    try {
      key = await authenticate(req, 'messages:write');
    } catch (error) {
      return handleError(error, reply, req.id, 'anthropic');
    }
    const parsed = messagesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendProtocolError(reply, 'anthropic', 400, 'invalid_request', 'Request body failed schema validation', req.id);
    }
    const required: Capability[] = ['text'];
    if (parsed.data.tools?.length) required.push('tools');
    if (parsed.data.stream) required.push('stream');
    let model: ModelPolicy;
    try {
      model = resolveModel(parsed.data.model, required, key.tenantId);
    } catch (error) {
      return handleError(error, reply, req.id, 'anthropic');
    }
    const maxTokens = Math.min(parsed.data.max_tokens, model.maxOutputTokens);
    return execute(req, reply, key, {
      dialect: 'anthropic',
      upstreamPath: '/v1/messages',
      body: { ...parsed.data, model: model.upstreamModel, max_tokens: maxTokens },
      stream: parsed.data.stream,
      model: parsed.data.model,
      estimateUnits:
        Math.ceil(maxTokens + (JSON.stringify(parsed.data.messages).length + textLength(parsed.data.system)) / 4) +
        deps.config.UPSTREAM_CONTEXT_OVERHEAD_UNITS,
      auditEvent: 'llm.messages.request',
      auditStreamEvent: 'llm.messages.stream.completed'
    });
  });

  app.post('/v1/messages/count_tokens', async (req, reply) => {
    let key: ApiKeyRecord;
    try {
      key = await authenticate(req, 'messages:write');
    } catch (error) {
      return handleError(error, reply, req.id, 'anthropic');
    }
    const parsed = countTokensRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendProtocolError(reply, 'anthropic', 400, 'invalid_request', 'Request body failed schema validation', req.id);
    }
    let model: ModelPolicy;
    try {
      model = resolveModel(parsed.data.model, ['text'], key.tenantId);
    } catch (error) {
      return handleError(error, reply, req.id, 'anthropic');
    }
    return execute(req, reply, key, {
      dialect: 'anthropic',
      upstreamPath: '/v1/messages/count_tokens',
      body: { ...parsed.data, model: model.upstreamModel },
      stream: false,
      model: parsed.data.model,
      estimateUnits: 1,
      auditEvent: 'llm.messages.count_tokens',
      auditStreamEvent: 'llm.messages.count_tokens'
    });
  });

  app.setErrorHandler((error, req, reply) => handleError(error, reply, req.id, 'openai'));
  return app;
}

function handleError(
  error: unknown,
  reply: FastifyReply,
  traceId: string,
  dialect: Dialect = 'openai'
) {
  if (error instanceof RateLimitError) {
    reply.header('retry-after', String(error.retryAfterSeconds));
    return sendProtocolError(reply, dialect, 429, 'rate_limited', 'Too many requests', traceId, true);
  }
  if (error instanceof AuthError || error instanceof PolicyError) {
    return sendProtocolError(reply, dialect, error.statusCode, error.code, error.message, traceId);
  }
  if (error instanceof OverloadError) {
    reply.header('retry-after', '1');
    return sendProtocolError(reply, dialect, 503, 'overloaded', 'Concurrency limit reached', traceId, true);
  }
  return sendProtocolError(
    reply,
    dialect,
    502,
    'gateway_error',
    'Request could not be completed',
    traceId,
    true
  );
}
