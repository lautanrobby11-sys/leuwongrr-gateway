export type RouteId =
  | 'health.live'
  | 'health.ready'
  | 'models.list'
  | 'chat.completions'
  | 'responses.create'
  | 'messages.create'
  | 'messages.count_tokens';

export interface AllowedRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  id: RouteId;
}

/**
 * Exact-match allowlist. There is deliberately no catch-all passthrough to
 * OmniRoute: a path that is not listed here never reaches upstream.
 */
export const PUBLIC_ALLOWLIST: readonly AllowedRoute[] = Object.freeze([
  { method: 'GET', pattern: /^\/health\/live$/, id: 'health.live' },
  { method: 'GET', pattern: /^\/health\/ready$/, id: 'health.ready' },
  { method: 'GET', pattern: /^\/v1\/models$/, id: 'models.list' },
  { method: 'POST', pattern: /^\/v1\/chat\/completions$/, id: 'chat.completions' },
  { method: 'POST', pattern: /^\/v1\/responses$/, id: 'responses.create' },
  { method: 'POST', pattern: /^\/v1\/messages$/, id: 'messages.create' },
  { method: 'POST', pattern: /^\/v1\/messages\/count_tokens$/, id: 'messages.count_tokens' }
]);

export function resolveRoute(method: string, path: string): RouteId | null {
  return (
    PUBLIC_ALLOWLIST.find((route) => route.method === method && route.pattern.test(path))?.id ?? null
  );
}
