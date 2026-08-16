import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './support/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

function start(body: unknown, status = 200): Harness {
  harness = createHarness(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
  );
  return harness;
}

/** The default harness key intentionally lacks the newer protocol scopes. */
function protocolToken(active: Harness): string {
  return active.db.tenants.issue({
    tenantId: 'tenant-a',
    name: 'protocol',
    scopes: ['responses:write', 'messages:write']
  }).plaintext;
}

function settledUnits(active: Harness): number | null {
  const row = active.db.db
    .prepare("SELECT units FROM usage_events WHERE tenant_id=? AND state='settled'")
    .get('tenant-a') as { units: number } | undefined;
  return row ? row.units : null;
}

describe('protocol surfaces', () => {
  it('keeps the Responses endpoint behind its own scope', async () => {
    const active = start({ id: 'resp_mock', usage: { total_tokens: 25 } });
    const denied = await active.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${active.token}` },
      payload: { model: 'lwrr-text', input: 'hello' }
    });
    expect(denied.statusCode).toBe(403);
    expect(active.upstreamCalls()).toBe(0);

    const allowed = await active.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${protocolToken(active)}` },
      payload: { model: 'lwrr-text', input: 'hello' }
    });
    expect(allowed.statusCode).toBe(200);
    expect(active.upstreamCalls()).toBe(1);
    expect(settledUnits(active)).toBe(25);
  });

  it('settles Anthropic budget from reported usage instead of the estimate', async () => {
    const active = start({
      id: 'msg_mock',
      type: 'message',
      usage: { input_tokens: 11, output_tokens: 7 }
    });
    const response = await active.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${protocolToken(active)}` },
      payload: { model: 'lwrr-text', max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] }
    });
    expect(response.statusCode).toBe(200);
    expect(settledUnits(active)).toBe(18);
  });

  it('answers Anthropic callers with the Anthropic error envelope', async () => {
    const active = start({ id: 'unused' });
    const response = await active.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${protocolToken(active)}` },
      payload: { model: 'not-a-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe('error');
    expect(response.json().error.type).toBe('not_found_error');
    expect(active.upstreamCalls()).toBe(0);
  });

  it('counts tokens through the same policy envelope', async () => {
    const active = start({ input_tokens: 42 });
    const response = await active.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${protocolToken(active)}` },
      payload: { model: 'lwrr-text', messages: [{ role: 'user', content: 'hi' }] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().input_tokens).toBe(42);
    expect(active.upstreamCalls()).toBe(1);
  });

  it('still refuses neighbouring paths that are not allowlisted', async () => {
    const active = start({ id: 'unused' });
    const headers = { authorization: `Bearer ${protocolToken(active)}` };
    expect((await active.app.inject({ method: 'GET', url: '/v1/responses', headers })).statusCode).toBe(404);
    expect(
      (
        await active.app.inject({
          method: 'POST',
          url: '/v1/messages/count_tokens/extra',
          headers,
          payload: {}
        })
      ).statusCode
    ).toBe(404);
    expect(active.upstreamCalls()).toBe(0);
  });

  it('forwards unknown request fields to the upstream instead of rejecting them', async () => {
    const active = start({ id: 'resp_mock', usage: { total_tokens: 25 } });
    const response = await active.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${protocolToken(active)}` },
      payload: { model: 'lwrr-text', input: 'hello', reasoning: { effort: 'high' }, store: true }
    });
    // Standard OpenAI clients send fields the gateway does not interpret
    // (logprobs, reasoning, store, ...). Those must reach OmniRoute, not be
    // rejected by a strict schema (ADR-008 amendment).
    expect(response.statusCode).toBe(200);
    expect(active.upstreamCalls()).toBe(1);
    expect(settledUnits(active)).toBe(25);
  });

  it('accepts agentic payloads with large toolsets and long histories', async () => {
    const active = start({ id: 'resp_mock', usage: { total_tokens: 25 } });
    // Coding agents attach their full toolset (MCP servers included) and the
    // whole conversation on every request; the old bounds (32 tools, 128
    // messages, 4096 max_tokens) rejected these as invalid requests.
    active.db.db
      .prepare("UPDATE models SET capabilities_json = ? WHERE public_id = 'lwrr-text'")
      .run(JSON.stringify(['text', 'stream', 'tools']));
    const tools = Array.from({ length: 96 }, (_, i) => ({
      type: 'function',
      function: { name: `tool_${i}`, parameters: {} }
    }));
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`
    }));
    const chat = await active.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${active.token}` },
      payload: { model: 'lwrr-text', messages, tools, max_tokens: 65536 }
    });
    expect(chat.statusCode).toBe(200);

    const anthropic = await active.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${protocolToken(active)}` },
      payload: {
        model: 'lwrr-text',
        max_tokens: 128000,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        tools
      }
    });
    expect(anthropic.statusCode).toBe(200);
    expect(active.upstreamCalls()).toBe(2);
  });
});
