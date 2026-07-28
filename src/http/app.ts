import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
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
import { resolveRoute } from '../policy/allowlist.js';
import { OverloadError } from '../policy/semaphore.js';
import { TokenBucketLimiter, RateLimitError } from '../policy/rate-limit.js';
import { TenantConcurrencyRegistry, TenantRateLimiterRegistry } from '../policy/tenant-limits.js';
import type { GatewayDatabase } from '../persistence/database.js';
import type { OmniRouteClient } from '../upstream.js';
import { createUpstreamExecutor } from './pipeline.js';
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

/**
 * All public traffic reaches the gateway through cloudflared on loopback, so
 * `req.ip` collapses every caller into one bucket. The forwarded header is
 * trusted only when the operator enabled it and the socket peer is the local
 * tunnel, otherwise a caller could spoof the header and bypass the limiter.
 */
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

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    requestTimeout: deps.config.REQUEST_TIMEOUT_MS,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    disableRequestLogging: true
  });

  // Source limiter protects the process before authentication work happens.
  const sourceLimiter = new TokenBucketLimiter(
    deps.config.RATE_LIMIT_RPM * 2,
    deps.config.RATE_LIMIT_BURST * 2,
    deps.config.RATE_LIMIT_MAX_ENTRIES
  );
  // Credential limiter enforces the per-key contract after authentication.
  const credentialLimiter = new TokenBucketLimiter(
    deps.config.RATE_LIMIT_RPM,
    deps.config.RATE_LIMIT_BURST,
    deps.config.RATE_LIMIT_MAX_ENTRIES
  );
  // Tenant registries make provisioned limits real instead of advisory.
  const tenantLimiter = new TenantRateLimiterRegistry(
    deps.config.TENANT_LIMIT_MAX_ENTRIES,
    deps.config.RATE_LIMIT_BURST
  );
  const tenantConcurrency = new TenantConcurrencyRegistry(deps.config.TENANT_LIMIT_MAX_ENTRIES);

  const execute = createUpstreamExecutor({
    config: deps.config,
    db: deps.db,
    upstream: deps.upstream,
    tenantConcurrency,
    onError: handleError
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const route = resolveRoute(req.method, path);
    if (!route) {
      return sendProtocolError(reply, 'openai', 404, 'route_not_found', 'Route is not available', req.id);
    }
    reply.header('x-request-id', req.id).header('cache-control', 'no-store');
    if (route === 'health.live' || route === 'health.ready') return;

    const decision = sourceLimiter.consume(clientIdentity(req, deps.config));
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      return sendProtocolError(reply, 'openai', 429, 'rate_limited', 'Too many requests', req.id, true);
    }
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
    return record;
  }

  /** Shared entitlement gate: capability match first, tenant policy second. */
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
    const token = req.headers['x-internal-ready-token'];
    if (typeof token !== 'string' || token !== deps.config.INTERNAL_READY_TOKEN) {
      return sendProtocolError(reply, 'openai', 404, 'route_not_found', 'Route is not available', req.id);
    }
    try {
      deps.db.db.prepare('SELECT 1').get();
    } catch {
      return sendProtocolError(reply, 'openai', 503, 'not_ready', 'Dependency unavailable', req.id, true);
    }
    // Readiness drives deploy verification and rollback, so it must observe the
    // upstream the gateway is useless without.
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

  app.get('/v1/models', async (req, reply) => {
    try {
      const key = await authenticate(req, 'models:read');
      return {
        object: 'list',
        data: listModels()
          .filter((m) => deps.db.modelEnabled(key.tenantId, m.publicId))
          .map((m) => ({
            id: m.publicId,
            object: 'model',
            owned_by: 'leuwongrr',
            capabilities: [...m.capabilities]
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
      return sendProtocolError(
        reply,
        'openai',
        400,
        'invalid_request',
        'Request body failed schema validation',
        req.id
      );
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
        // Usage must be reported for streaming settlement to be real.
        stream_options: parsed.data.stream
          ? { ...parsed.data.stream_options, include_usage: true }
          : parsed.data.stream_options
      },
      stream: parsed.data.stream,
      model: parsed.data.model,
      estimateUnits: Math.ceil(maxTokens + JSON.stringify(parsed.data.messages).length / 4),
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
      return sendProtocolError(
        reply,
        'openai',
        400,
        'invalid_request',
        'Request body failed schema validation',
        req.id
      );
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
      parsed.data.max_output_tokens ?? DEFAULT_MAX_TOKENS,
      model.maxOutputTokens
    );
    return execute(req, reply, key, {
      dialect: 'openai',
      upstreamPath: '/v1/responses',
      body: { ...parsed.data, model: model.upstreamModel, max_output_tokens: maxTokens },
      stream: parsed.data.stream,
      model: parsed.data.model,
      estimateUnits: Math.ceil(
        maxTokens + (textLength(parsed.data.input) + textLength(parsed.data.instructions)) / 4
      ),
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
      return sendProtocolError(
        reply,
        'anthropic',
        400,
        'invalid_request',
        'Request body failed schema validation',
        req.id
      );
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
      estimateUnits: Math.ceil(
        maxTokens +
          (JSON.stringify(parsed.data.messages).length + textLength(parsed.data.system)) / 4
      ),
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
      return sendProtocolError(
        reply,
        'anthropic',
        400,
        'invalid_request',
        'Request body failed schema validation',
        req.id
      );
    }

    let model: ModelPolicy;
    try {
      model = resolveModel(parsed.data.model, ['text'], key.tenantId);
    } catch (error) {
      return handleError(error, reply, req.id, 'anthropic');
    }

    // Counting is cheap but still upstream work, so it stays inside the same
    // budget, tenant concurrency, and audit envelope.
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
    return sendProtocolError(
      reply,
      dialect,
      503,
      'overloaded',
      'Concurrency limit reached',
      traceId,
      true
    );
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
