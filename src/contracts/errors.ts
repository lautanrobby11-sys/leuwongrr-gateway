import type { FastifyReply } from 'fastify';

export function sendError(reply:FastifyReply,status:number,code:string,message:string,traceId:string,retryable=false) {
  return reply.code(status).send({ error:{ code,message,trace_id:traceId,retryable } });
}
