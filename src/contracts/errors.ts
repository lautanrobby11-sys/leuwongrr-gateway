import type { FastifyReply } from 'fastify';

/** Error shape follows the protocol the caller asked for, not our internal one. */
export type Dialect = 'openai' | 'anthropic';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  traceId: string,
  retryable = false
) {
  return reply.code(status).send({ error: { code, message, trace_id: traceId, retryable } });
}

const ANTHROPIC_ERROR_TYPES: Readonly<Record<number, string>> = Object.freeze({
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'invalid_request_error',
  413: 'request_too_large',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error'
});

export function sendProtocolError(
  reply: FastifyReply,
  dialect: Dialect,
  status: number,
  code: string,
  message: string,
  traceId: string,
  retryable = false
) {
  if (dialect !== 'anthropic') {
    return sendError(reply, status, code, message, traceId, retryable);
  }
  return reply.code(status).send({
    type: 'error',
    error: { type: ANTHROPIC_ERROR_TYPES[status] ?? 'api_error', message },
    code,
    trace_id: traceId,
    retryable
  });
}
