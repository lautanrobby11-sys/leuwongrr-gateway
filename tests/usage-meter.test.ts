import { describe, expect, it } from 'vitest';
import { createUsageMeter } from '../src/http/usage.js';

describe('usage meter', () => {
  it('reports nothing when upstream never sends usage', () => {
    const meter = createUsageMeter('openai');
    meter.observe({ id: 'chatcmpl', choices: [] });
    expect(meter.units()).toBeNull();
  });

  it('reads the OpenAI total from a stream split across chunks', () => {
    const meter = createUsageMeter('openai');
    meter.observeSseChunk('data: {"choices":[{"delta":{"content":"h"}}]}\n\ndata: {"usa');
    expect(meter.units()).toBeNull();
    meter.observeSseChunk('ge":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15}}\n\n');
    meter.observeSseChunk('data: [DONE]\n\n');
    expect(meter.units()).toBe(15);
  });

  it('sums Anthropic input and output reported in separate events', () => {
    const meter = createUsageMeter('anthropic');
    meter.observeSseChunk(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n'
    );
    meter.observeSseChunk(
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n'
    );
    expect(meter.units()).toBe(42);
  });

  it('ignores malformed events instead of throwing', () => {
    const meter = createUsageMeter('openai');
    meter.observeSseChunk('data: not-json\n\n:keep-alive\n\n');
    meter.observeSseChunk('data: {"usage":{"total_tokens":4}}\n\n');
    expect(meter.units()).toBe(4);
  });
});
