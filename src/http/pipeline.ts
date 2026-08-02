import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { ApiKeyRecord } from '../auth/api-keys.js';
import type { GatewayDatabase } from '../persistence/database.js';
import type { OmniRouteClient } from '../upstream.js';
import { claim, complete, abandon } from '../persistence/idempotency.js';
import type { TenantConcurrencyRegistry } from '../policy/tenant-limits.js';
import { sendProtocolError, type Dialect } from '../contracts/errors.js';
import { createUsageMeter } from './usage.js';
import { registerActiveStream } from './stream-lifecycle.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface UpstreamCall {
  dialect: Dialect;
  upstreamPath: string;
  body: Record<string, unknown>;
  stream: boolean;
  model: string;
  estimateUnits: number;
  auditEvent: string;
  auditStreamEvent: string;
}

export interface ExecutorDeps {
  config: Config;
  db: GatewayDatabase;
  upstream: OmniRouteClient;
  tenantConcurrency: TenantConcurrencyRegistry;
  onError: (error: unknown, reply: FastifyReply, traceId: string, dialect: Dialect) => unknown;
}

export function createUpstreamExecutor(deps: ExecutorDeps) {
  return async function execute(
    req: FastifyRequest,
    reply: FastifyReply,
    key: ApiKeyRecord,
    call: UpstreamCall
  ): Promise<unknown> {
    const dialect = call.dialect;
    const requestHash = createHash('sha256').update(JSON.stringify(call.body)).digest('hex');
    const idem = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
    if (idem && !IDEMPOTENCY_KEY_PATTERN.test(idem)) return sendProtocolError(reply, dialect, 400, 'invalid_idempotency_key', 'Invalid Idempotency-Key', req.id);
    if (idem && call.stream) return sendProtocolError(reply, dialect, 400, 'stream_idempotency_unsupported', 'Idempotency-Key is for non-streaming requests', req.id);
    if (idem) {
      const state = claim(deps.db, key.tenantId, idem, requestHash);
      if (state.state === 'cached') return reply.code(state.statusCode).send(state.body);
      if (state.state === 'conflict') return sendProtocolError(reply, dialect, 409, 'idempotency_conflict', 'Key reused with different request', req.id);
      if (state.state === 'in_progress') {
        reply.header('retry-after', '1');
        return sendProtocolError(reply, dialect, 409, 'idempotency_in_progress', 'Matching request is still running', req.id, true);
      }
    }
    let reservation: string;
    try {
      reservation = deps.db.reserveBudget(key.tenantId, req.id, call.estimateUnits, deps.config.DAILY_BUDGET_UNITS);
    } catch {
      if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
      return sendProtocolError(reply, dialect, 402, 'budget_exceeded', 'Daily budget exhausted', req.id);
    }
    const tenantLimits = deps.db.tenants.limits(key.tenantId);
    const releaseTenantSlot = deps.tenantConcurrency.tryAcquire(key.tenantId, tenantLimits?.maxConcurrent ?? deps.config.TENANT_MAX_CONCURRENT);
    if (!releaseTenantSlot) {
      deps.db.releaseBudget(reservation, key.tenantId);
      if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
      reply.header('retry-after', '1');
      return sendProtocolError(reply, dialect, 503, 'tenant_overloaded', 'Tenant concurrency limit reached', req.id, true);
    }
    let slotHandedToStream = false;
    const meter = createUsageMeter(dialect);
    const aborter = new AbortController();
    req.raw.once('aborted', () => aborter.abort());
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) aborter.abort(); });
    try {
      const upstream = await deps.upstream.request(call.upstreamPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': req.id },
        body: JSON.stringify(call.body)
      }, aborter.signal);
      if (call.stream) {
        if (!upstream.ok || !upstream.body) {
          // OmniRouteClient releases its permit only when the body ends, is
          // cancelled, or errors. Returning here without touching the body leaked
          // one permit per failed streaming request, and UPSTREAM_CONCURRENCY
          // defaults to 4, so a handful of upstream errors wedged every later
          // call - including the readiness probe, which shares this semaphore.
          // The non-streaming path below is safe precisely because it always
          // awaits upstream.json() before it inspects upstream.ok.
          await upstream.text().catch(() => undefined);
          deps.db.releaseBudget(reservation, key.tenantId);
          return sendProtocolError(reply, dialect, 502, 'upstream_error', 'Upstream rejected request', req.id, true);
        }
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-request-id': req.id, 'x-accel-buffering': 'no' });
        const stream = Readable.fromWeb(upstream.body as never);
        let idleTimer: NodeJS.Timeout | null = null;
        let streamFinalized = false;
        let unregister = () => undefined;
        const clearIdle = () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        };
        const finalizeFailure = () => {
          if (streamFinalized) return;
          streamFinalized = true;
          unregister();
          clearIdle();
          releaseTenantSlot();
          deps.db.releaseBudget(reservation, key.tenantId);
        };
        const finalizeSuccess = () => {
          if (streamFinalized) return;
          streamFinalized = true;
          unregister();
          clearIdle();
          releaseTenantSlot();
          const reported = meter.units();
          deps.db.settleBudget(reservation, key.tenantId, reported ?? call.estimateUnits);
          deps.db.audit(key.tenantId, call.auditStreamEvent, req.id, { model: call.model, stream: true, estimate: call.estimateUnits, actual: reported ?? call.estimateUnits, reconciled: reported !== null });
        };
        const closeStream = (reason: string) => {
          finalizeFailure();
          aborter.abort();
          if (!stream.destroyed) stream.destroy(new Error(reason));
          if (!reply.raw.writableEnded) reply.raw.end();
        };
        unregister = registerActiveStream(deps.db, () => closeStream('stream_shutdown'));
        const armIdle = () => {
          clearIdle();
          idleTimer = setTimeout(() => closeStream('stream_idle_timeout'), deps.config.STREAM_IDLE_TIMEOUT_MS);
          idleTimer.unref();
        };
        reply.raw.once('close', () => {
          if (!reply.raw.writableEnded) closeStream('client_disconnected');
        });
        stream.on('data', (chunk: Buffer | string) => {
          armIdle();
          meter.observeSseChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        });
        stream.once('end', finalizeSuccess);
        stream.once('error', () => {
          finalizeFailure();
          if (!reply.raw.writableEnded) reply.raw.end();
        });
        armIdle();
        slotHandedToStream = true;
        stream.pipe(reply.raw);
        return reply;
      }
      const body = (await upstream.json()) as unknown;
      if (!upstream.ok) {
        deps.db.releaseBudget(reservation, key.tenantId);
        if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
        return sendProtocolError(reply, dialect, 502, 'upstream_error', 'Upstream rejected request', req.id, upstream.status >= 500);
      }
      meter.observe(body);
      const reported = meter.units();
      deps.db.settleBudget(reservation, key.tenantId, reported ?? call.estimateUnits);
      deps.db.audit(key.tenantId, call.auditEvent, req.id, { model: call.model, stream: false, status: upstream.status, estimate: call.estimateUnits, actual: reported ?? call.estimateUnits, reconciled: reported !== null });
      if (idem) complete(deps.db, key.tenantId, idem, requestHash, upstream.status, body);
      return reply.code(upstream.status).send(body);
    } catch (error) {
      deps.db.releaseBudget(reservation, key.tenantId);
      if (idem) abandon(deps.db, key.tenantId, idem, requestHash);
      return deps.onError(error, reply, req.id, dialect);
    } finally {
      if (!slotHandedToStream) releaseTenantSlot();
    }
  };
}
