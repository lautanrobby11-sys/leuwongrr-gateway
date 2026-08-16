import { describe, expect, it } from 'vitest';
import { appLabelForUserAgent } from '../src/http/app-label.js';

describe('appLabelForUserAgent', () => {
  it('recognises the coding agents by their user agents', () => {
    // Real-world agent strings the gateway sees on the data plane. Order matters:
    // an agent that names itself Claude Code must not collapse to a bare library.
    const cases: Array<[string, string]> = [
      ['ZCode/1.4 (windows)', 'zcode'],
      ['z.code cli', 'zcode'],
      ['claude-code/0.9.1', 'claude-code'],
      ['Claude Code (macOS)', 'claude-code'],
      ['claude-cli/2.0', 'claude-cli'],
      ['codex-cli/1.0', 'codex'],
      ['Cursor/0.42', 'cursor'],
      ['OpenAI/Python 1.30.1', 'openai-python'],
      ['openai-node/4.20.0', 'openai-node'],
      ['python-requests/2.31.0', 'python'],
      ['undici', 'node'],
      ['curl/8.4.0', 'curl'],
      ['Mozilla/5.0 (X11; Linux x86_64)', 'browser']
    ];
    for (const [agent, label] of cases) {
      expect({ agent, label: appLabelForUserAgent(agent) }).toEqual({ agent, label });
    }
  });

  it('prefers the more specific agent when several patterns could match', () => {
    // A browser string that also mentions a library must still read as a browser,
    // and an SDK riding on top of a generic client keeps its SDK identity.
    expect(appLabelForUserAgent('openai-python/1.0 python-requests/2.31')).toBe('openai-python');
  });

  it('falls back to other for an empty, missing, or unknown agent', () => {
    expect(appLabelForUserAgent(undefined)).toBe('other');
    expect(appLabelForUserAgent(null)).toBe('other');
    expect(appLabelForUserAgent('')).toBe('other');
    expect(appLabelForUserAgent('   ')).toBe('other');
    expect(appLabelForUserAgent('SomeUnknownClient/9.9')).toBe('other');
  });
});
