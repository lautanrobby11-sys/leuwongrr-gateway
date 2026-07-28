import { describe, expect, it } from 'vitest';
import { createUsageMeter } from '../src/http/usage.js';

/**
 * Streamed usage decides what the tenant is finally charged, so a hostile or
 * broken upstream must not be able to corrupt it, inflate it, or grow memory
 * without bound. The meter is exercised directly because these are properties
 * of the parser, not of the transport.
 */
describe('streamed usage accounting', () => {
  it('ignores malformed events and reports nothing rather than a guess', () => {
    const meter = createUsageMeter('openai');
    meter.observeSseChunk('data: {"usage": {"total_tokens":\n');
    meter.observeSseChunk('data: not json at all\n');
    meter.observeSseChunk(': keep-alive comment\n');
    meter.observeSseChunk('event: ping\n');
    meter.observeSseChunk('data: [DONE]\n');
    expect(meter.units()).toBeNull();
  });

  it('reassembles an event split across chunk boundaries', () => {
    const meter = createUsageMeter('openai');
    meter.observeSseChunk('data: {"usage":');
    meter.observeSseChunk(' {"total_tokens": 42}');
    expect(meter.units()).toBeNull();
    meter.observeSseChunk('}\n');
    expect(meter.units()).toBe(42);
  });

  it('sums the separate Anthropic input and output events', () => {
    const meter = createUsageMeter('anthropic');
    meter.observeSseChunk('data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n');
    meter.observeSseChunk('data: {"type":"message_delta","usage":{"output_tokens":7}}\n');
    expect(meter.units()).toBe(18);
  });

  it('never lets a later event lower an already reported count', () => {
    const meter = createUsageMeter('anthropic');
    meter.observeSseChunk('data: {"usage":{"output_tokens":40}}\n');
    meter.observeSseChunk('data: {"usage":{"output_tokens":1}}\n');
    expect(meter.units()).toBe(40);
  });

  it('refuses a single event large enough to be an attack', () => {
    const meter = createUsageMeter('openai');
    const padding = 'x'.repeat(40_000);
    meter.observeSseChunk(`data: {"pad":"${padding}","usage":{"total_tokens":999999}}\n`);
    expect(meter.units()).toBeNull();
  });

  it('survives an upstream that never sends a newline, then still parses', () => {
    const meter = createUsageMeter('openai');
    for (let index = 0; index < 8; index += 1) {
      meter.observeSseChunk('n'.repeat(50_000));
    }
    expect(meter.units()).toBeNull();
    meter.observeSseChunk('\ndata: {"usage":{"total_tokens":5}}\n');
    expect(meter.units()).toBe(5);
  });

  it('ignores a negative or non numeric count', () => {
    const meter = createUsageMeter('openai');
    meter.observeSseChunk('data: {"usage":{"total_tokens":-5}}\n');
    meter.observeSseChunk('data: {"usage":{"total_tokens":"many"}}\n');
    expect(meter.units()).toBeNull();
  });
});
