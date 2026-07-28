export type RouteId = 'health.live'|'health.ready'|'models.list'|'chat.completions';
export interface AllowedRoute { method: 'GET'|'POST'; pattern: RegExp; id: RouteId }

export const PUBLIC_ALLOWLIST: readonly AllowedRoute[] = Object.freeze([
  { method: 'GET', pattern: /^\/health\/live$/, id: 'health.live' },
  { method: 'GET', pattern: /^\/health\/ready$/, id: 'health.ready' },
  { method: 'GET', pattern: /^\/v1\/models$/, id: 'models.list' },
  { method: 'POST', pattern: /^\/v1\/chat\/completions$/, id: 'chat.completions' }
]);

export function resolveRoute(method: string, path: string): RouteId | null {
  return PUBLIC_ALLOWLIST.find((route) => route.method === method && route.pattern.test(path))?.id ?? null;
}
