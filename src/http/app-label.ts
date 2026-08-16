/**
 * Classifies a client by its User-Agent into a short, stable label for the
 * member usage ledger ("which app spent this"). Ordered by specificity: an
 * agent that identifies itself as Claude Code must not collapse into a generic
 * library label, and unknown agents fall back to `other` rather than a guess.
 * The label is metadata only — it never feeds an authorization decision.
 */
const LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/z[\s._-]?code|zcode/i, 'zcode'],
  [/claude[\s._-]?code/i, 'claude-code'],
  [/claude[\s._-]?cli/i, 'claude-cli'],
  [/codex/i, 'codex'],
  [/cursor/i, 'cursor'],
  [/cline/i, 'cline'],
  [/continue\b/i, 'continue'],
  [/openai-python|openai\/python/i, 'openai-python'],
  [/openai-node|openai\/node|openai\/js/i, 'openai-node'],
  [/anthropic-sdk-python|anthropic\/python/i, 'anthropic'],
  [/anthropic-sdk-typescript|anthropic\/(?:node|js|ts)/i, 'anthropic'],
  [/postmanruntime|postman/i, 'postman'],
  [/insomnia/i, 'insomnia'],
  [/httpie/i, 'httpie'],
  [/python-requests|python-urllib|aiohttp|httpx/i, 'python'],
  [/node-fetch|undici|axios|got\(/i, 'node'],
  [/go-http-client/i, 'go'],
  [/okhttp/i, 'okhttp'],
  [/java\//i, 'java'],
  [/dotnet|restsharp/i, 'dotnet'],
  [/swift/i, 'swift'],
  [/mozilla\//i, 'browser'],
  [/curl\//i, 'curl'],
  [/wget/i, 'wget']
];

export function appLabelForUserAgent(userAgent: string | undefined | null): string {
  if (typeof userAgent !== 'string' || userAgent.trim() === '') return 'other';
  for (const [pattern, label] of LABELS) {
    if (pattern.test(userAgent)) return label;
  }
  return 'other';
}
