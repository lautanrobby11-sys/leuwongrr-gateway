import type { Dialect } from '../contracts/errors.js';

/** Guards against an upstream that never emits a newline or sends huge events. */
const MAX_BUFFERED_BYTES = 65_536;
const MAX_EVENT_BYTES = 32_768;

/** Per-request detail the meter can recover from upstream reporting. */
export interface UsageDetailSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  thinkingTokens: number | null;
  finishReason: string | null;
}

/**
 * Full per-request detail persisted at settlement (console overhaul phase B).
 * It augments the meter snapshot with request-scoped facts the meter never
 * sees - the resolved model, wall-clock duration, and the caller's app label
 * derived from the user agent. Every field is optional: an upstream that
 * reports only totals leaves the splits null, and historical rows keep nulls.
 */
export interface UsageDetail {
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  thinkingTokens?: number | null;
  durationMs?: number | null;
  finishReason?: string | null;
  userAgent?: string | null;
  appLabel?: string | null;
}

export interface UsageMeter {
  /** Observe a parsed JSON payload, streaming event or complete response. */
  observe: (payload: unknown) => void;
  /** Observe a raw SSE fragment; partial lines are buffered until complete. */
  observeSseChunk: (chunk: string) => void;
  /** Reported usage in token units, or null when upstream reported none. */
  units: () => number | null;
  /** Token splits, cache/thinking counts and the finish reason, when reported. */
  detail: () => UsageDetailSnapshot;
}

function readCount(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNestedCount(source: Record<string, unknown>, container: string, field: string): number | null {
  const nested = source[container];
  if (typeof nested !== 'object' || nested === null) return null;
  return readCount(nested as Record<string, unknown>, field);
}

function usageObject(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const container = payload as Record<string, unknown>;
  const direct = container.usage;
  if (typeof direct === 'object' && direct !== null) return direct as Record<string, unknown>;
  // Anthropic reports the input count inside the message_start envelope.
  const message = container.message;
  if (typeof message === 'object' && message !== null) {
    const nested = (message as Record<string, unknown>).usage;
    if (typeof nested === 'object' && nested !== null) return nested as Record<string, unknown>;
  }
  return null;
}

/**
 * The stop condition of a generation, normalised across dialects: OpenAI calls
 * it finish_reason on choices (or status on Responses), Anthropic reports
 * stop_reason in message_delta. Only the first non-null value is kept, matching
 * how the usage counters take the upstream's final word.
 */
function readFinishReason(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const container = payload as Record<string, unknown>;
  const choices = container.choices;
  if (Array.isArray(choices) && choices.length > 0 && typeof choices[0] === 'object' && choices[0] !== null) {
    const reason = (choices[0] as Record<string, unknown>).finish_reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  const delta = container.delta;
  if (typeof delta === 'object' && delta !== null) {
    const reason = (delta as Record<string, unknown>).stop_reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  const message = container.message;
  if (typeof message === 'object' && message !== null) {
    const reason = (message as Record<string, unknown>).stop_reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  }
  if (container.status === 'completed') return 'completed';
  if (container.status === 'incomplete') {
    const details = container.incomplete_details;
    if (typeof details === 'object' && details !== null) {
      const reason = (details as Record<string, unknown>).reason;
      if (typeof reason === 'string' && reason !== '') return `incomplete:${reason}`;
    }
    return 'incomplete';
  }
  return null;
}

/**
 * Collects the usage actually reported by upstream so budget settlement stops
 * relying on the pre-request estimate. Anthropic splits input and output across
 * separate stream events, so both are tracked and summed at the end. The same
 * observations also feed the per-request detail stored on the usage event.
 */
export function createUsageMeter(dialect: Dialect): UsageMeter {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let finishReason: string | null = null;
  let buffer = '';

  const observe = (payload: unknown): void => {
    const reason = readFinishReason(payload);
    if (reason !== null) finishReason = reason;

    const usage = usageObject(payload);
    if (!usage) return;

    // OpenAI reports cache and reasoning inside detail objects; Anthropic
    // reports cache reads at the top level of the usage object.
    const openaiCached = readNestedCount(usage, 'prompt_tokens_details', 'cached_tokens');
    const anthropicCached = readCount(usage, 'cache_read_input_tokens');
    if (openaiCached !== null) cachedTokens = openaiCached;
    if (anthropicCached !== null) cachedTokens = anthropicCached;
    const reasoning = readNestedCount(usage, 'completion_tokens_details', 'reasoning_tokens');
    if (reasoning !== null) thinkingTokens = reasoning;

    if (dialect === 'anthropic') {
      const nextInput = readCount(usage, 'input_tokens');
      const nextOutput = readCount(usage, 'output_tokens');
      if (nextInput !== null) inputTokens = Math.max(inputTokens ?? 0, nextInput);
      if (nextOutput !== null) outputTokens = Math.max(outputTokens ?? 0, nextOutput);
      return;
    }

    const prompt = readCount(usage, 'prompt_tokens') ?? readCount(usage, 'input_tokens');
    const completion = readCount(usage, 'completion_tokens') ?? readCount(usage, 'output_tokens');
    if (prompt !== null) promptTokens = prompt;
    if (completion !== null) completionTokens = completion;
    const total = readCount(usage, 'total_tokens');
    if (total !== null) {
      totalTokens = total;
      return;
    }
    if (prompt !== null || completion !== null) totalTokens = (prompt ?? 0) + (completion ?? 0);
  };

  const observeSseChunk = (chunk: string): void => {
    buffer += chunk;
    const boundary = buffer.lastIndexOf('\n');
    if (boundary === -1) {
      if (buffer.length > MAX_BUFFERED_BYTES) buffer = buffer.slice(-MAX_BUFFERED_BYTES);
      return;
    }
    const completed = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    if (buffer.length > MAX_BUFFERED_BYTES) buffer = buffer.slice(-MAX_BUFFERED_BYTES);

    for (const line of completed.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]' || data.length > MAX_EVENT_BYTES) continue;
      try {
        observe(JSON.parse(data));
      } catch {
        // A non-JSON or truncated event is ignored; usage falls back to estimate.
      }
    }
  };

  const units = (): number | null => {
    if (dialect === 'anthropic') {
      if (inputTokens === null && outputTokens === null) return null;
      return (inputTokens ?? 0) + (outputTokens ?? 0);
    }
    return totalTokens;
  };

  const detail = (): UsageDetailSnapshot => ({
    inputTokens: dialect === 'anthropic' ? inputTokens : promptTokens,
    outputTokens: dialect === 'anthropic' ? outputTokens : completionTokens,
    cachedTokens,
    thinkingTokens,
    finishReason: finishReason === null ? null : finishReason.slice(0, 32)
  });

  return { observe, observeSseChunk, units, detail };
}
