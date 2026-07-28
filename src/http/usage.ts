import type { Dialect } from '../contracts/errors.js';

/** Guards against an upstream that never emits a newline or sends huge events. */
const MAX_BUFFERED_BYTES = 65_536;
const MAX_EVENT_BYTES = 32_768;

export interface UsageMeter {
  /** Observe a parsed JSON payload, streaming event or complete response. */
  observe: (payload: unknown) => void;
  /** Observe a raw SSE fragment; partial lines are buffered until complete. */
  observeSseChunk: (chunk: string) => void;
  /** Reported usage in token units, or null when upstream reported none. */
  units: () => number | null;
}

function readCount(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
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
 * Collects the usage actually reported by upstream so budget settlement stops
 * relying on the pre-request estimate. Anthropic splits input and output across
 * separate stream events, so both are tracked and summed at the end.
 */
export function createUsageMeter(dialect: Dialect): UsageMeter {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let buffer = '';

  const observe = (payload: unknown): void => {
    const usage = usageObject(payload);
    if (!usage) return;

    if (dialect === 'anthropic') {
      const nextInput = readCount(usage, 'input_tokens');
      const nextOutput = readCount(usage, 'output_tokens');
      if (nextInput !== null) inputTokens = Math.max(inputTokens ?? 0, nextInput);
      if (nextOutput !== null) outputTokens = Math.max(outputTokens ?? 0, nextOutput);
      return;
    }

    const total = readCount(usage, 'total_tokens');
    if (total !== null) {
      totalTokens = total;
      return;
    }
    const prompt = readCount(usage, 'prompt_tokens') ?? readCount(usage, 'input_tokens');
    const completion = readCount(usage, 'completion_tokens') ?? readCount(usage, 'output_tokens');
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

  return { observe, observeSseChunk, units };
}
