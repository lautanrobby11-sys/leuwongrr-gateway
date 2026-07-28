import Fastify, { type FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Config } from '../config.js';
import {
  bearerToken,
  requireScope,
  AuthError,
  type ApiKeyRecord,
  type Scope
} from '../auth/api-keys.js';
import { chatRequestSchema } from '../contracts/chat.js';
import { sendError } from '../contracts/errors.js';
import { listModels, requireModel, PolicyError } from '../policy/capabilities.js';
import { resolveRoute } from '../policy/allowlist.js';
import { OverloadError } from '../policy/semaphore.js';
import { TokenBucketLimiter, RateLimitError } from '../policy/rate-limit.js';
import type { GatewayDatabase } from '../persistence/database.js';
import { claim, complete, abandon } from '../persistence/idempotency.js';
import type { OmniRouteClient } from '../upstream.js';
import type { Logger } from 'pino';

export interface AppDeps {
  config: Config;
  db: GatewayDatabase;
  upstream: OmniRouteClient;
  logger: Logger;
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

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    const route = resolveRoute(req.method, path);
    if (!route) {
      return sendError(reply, 404, 'route_not_found', 'Route is not available', req.id);
    }
    reply.header('x-request-id', req.id).header('cache-control', 'no-store');
    if (route === 'health.live' || route === 'health.ready') return;

    const decision = sourceLimiter.consume(req.ip);
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      return sendError(reply, 429, 'rate_limited', 'Too many requests', req.id, true);
    }
  });

  async function authenticate(req: FastifyRequest, scope: Scope): Promise<ApiKeyRecord> {
    const token = bearerToken(req.headers.authorization);
    const record = token ? deps.db.authenticate(token) : null;
    if (!record) throw new AuthError('invalid_api_key', 401);
    requireScope(record, scope);
    const decision = credentialLimiter.consume(record.keyHash);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
    return record;
  }

  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (req, reply) => {
    const token = req.headers['x-internal-ready-token'];
    if (typeof token !== 'string' || token !== deps.config.INTERNAL_READY_TOKEN) {
      return sendError(reply, 404, 'route_not_found', 'Route is not available', req.id);
    }
    try {
      deps.db.db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch {
      return sendError(reply, 503, 'not_ready', 'Dependency unavailable', req.id, true);
    }
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
      return handleError(error, reply, req.id);
    }
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    let key: ApiKeyRecord;
    try {
      key = await authenticate(req, 'chat:write');
    } catch (error) {
      return handleError(error, reply, req.id);
    }

    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request', 'Request body failed schema validation', req.id);
    }

    const required = parsed.data.tools?.length ? (['text', 'tools'] as const) : (['text'] as const);
    let model;
    try {
      model = requireModel(parsed.data.model, required);
    } catch (error) {
      return handleError(error, reply, req.id);
    }

    if (!deps.db.modelEnabled(key.tenantId, model.publicId)) {
      return sendError(reply, 403, 'model_not_entitled', 'Model is not enabled for tenant', req.id);
    }

    const maxTokens = Math.min(parsed.data.max_tokens ?? 1024, model.maxOutputTokens);
    const upstreamBody = { ...parsed.data, model: model.upstreamModel, max_tokens: maxTokens };
    const requestHash = createHash('sha256').update(JSON.stringify(upstreamBody)).digest('hex');
    const idem =
      typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;

    if (idem && !/^[A-Za-z0-9._:-]{8,128}$/.test(idem)) {
      return sendError(reply, 400, 'invalid_idempotency_key', 'Invalid Idempotency-Key', req.id);
    }
    if (idem && parsed.data.stream) {
      return sendError(
        reply,
        400,
        'stream_idempotency_unsupported',
        'Idempotency-Key is for non-streaming requests',
        req.id
      );
    }

    if (idem) {
      const state = claim(deps.db, key.tenantId, idem, requestHash);
      if (state.state === 'cached') return reply.code(state.statusCode).send(state.body);
      if (state.state === 'conflict') {
        return sendError(reply, 409, 'idempotency_conflict', 'Key reused with different request', req.id);
      }
      if (state.state === 'in_progress') {
        return reply.header('retry-after', '1').code(409).send({
          error: {
            code: 'idempotency_in_progress',
            message: 'Matching request is still running',
            trace_id: req.id,
            retryable: true
          }
        });
      }
    }

    const estimate = Math.ceil(maxTokens + JSON.stringify(parsed.data.messages).length / 4);
    let reservation: string;
    try {
      reservation = deps.db.reserveBudget(
        key.tenantId,
        req.id,
        estimate,
        deps.config.DAILY_BUDGET_UNITS
      );
    } catch {
      if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
      return sendError(reply, 402, 'budget_exceeded', 'Daily budget exhausted', req.id);
    }

    const aborter = new AbortController();
    req.raw.once('aborted', () => aborter.abort());
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) aborter.abort();
    });

    try {
      const upstream = await deps.upstream.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-request-id': req.id },
          body: JSON.stringify(upstreamBody)
        },
        aborter.signal
      );

      if (parsed.data.stream) {
        if (!upstream.ok || !upstream.body) {
          deps.db.releaseBudget(reservation, key.tenantId);
          return sendError(reply, 502, 'upstream_error', 'Upstream rejected request', req.id, true);
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'x-request-id': req.id,
          'x-accel-buffering': 'no'
        });
        const stream = Readable.fromWeb(upstream.body as never);

        // A stalled upstream must not hold a connection, permit, and budget
        // reservation open indefinitely on a small host.
        let idleTimer: NodeJS.Timeout | null = null;
        const clearIdle = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };
        const armIdle = () => {
          clearIdle();
          idleTimer = setTimeout(() => {
            aborter.abort();
            stream.destroy(new Error('stream_idle_timeout'));
          }, deps.config.STREAM_IDLE_TIMEOUT_MS);
          idleTimer.unref();
        };

        const onDisconnect = () => {
          if (!reply.raw.writableEnded) stream.destroy(new Error('client_disconnected'));
        };
        reply.raw.once('close', onDisconnect);
        stream.on('data', armIdle);
        stream.once('end', () => {
          clearIdle();
          deps.db.settleBudget(reservation, key.tenantId, estimate);
          deps.db.audit(key.tenantId, 'llm.stream.completed', req.id, { model: parsed.data.model });
        });
        stream.once('error', () => {
          clearIdle();
          deps.db.releaseBudget(reservation, key.tenantId);
          if (!reply.raw.writableEnded) reply.raw.end();
        });
        armIdle();
        stream.pipe(reply.raw);
        return reply;
      }

      const body = (await upstream.json()) as unknown;
      if (!upstream.ok) {
        deps.db.releaseBudget(reservation, key.tenantId);
        if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
        return sendError(
          reply,
          502,
          'upstream_error',
          'Upstream rejected request',
          req.id,
          upstream.status >= 500
        );
      }

      deps.db.settleBudget(reservation, key.tenantId, estimate);
      deps.db.audit(key.tenantId, 'llm.request', req.id, {
        model: parsed.data.model,
        stream: false,
        status: upstream.status
      });
      if (idem) complete(deps.db, key.tenantId, idem, requestHash, upstream.status, body);
      return reply.code(upstream.status).send(body);
    } catch (error) {
      deps.db.releaseBudget(reservation, key.tenantId);
      if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
      return handleError(error, reply, req.id);
    }
  });

  app.setErrorHandler((error, req, reply) => handleError(error, reply, req.id));
  return app;
}

function handleError(error: unknown, reply: Parameters<typeof sendError>[0], traceId: string) {
  if (error instanceof RateLimitError) {
    reply.header('retry-after', String(error.retryAfterSeconds));
    return sendError(reply, 429, 'rate_limited', 'Too many requests', traceId, true);
  }
  if (error instanceof AuthError || error instanceof PolicyError) {
    return sendError(reply, error.statusCode, error.code, error.message, traceId);
  }
  if (error instanceof OverloadError) {
    reply.header('retry-after', '1');
    return sendError(reply, 503, 'overloaded', 'Concurrency limit reached', traceId, true);
  }
  return sendError(reply, 502, 'gateway_error', 'Request could not be completed', traceId, true);
}
