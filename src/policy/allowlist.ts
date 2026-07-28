export type RouteId =
  | 'health.live'
  | 'health.ready'
  | 'models.list'
  | 'chat.completions'
  | 'responses.create'
  | 'messages.create'
  | 'messages.count_tokens'
  | 'console.page'
  | 'console.asset'
  | 'console.auth'
  | 'console.callback'
  | 'console.member'
  | 'console.admin'
  | 'webhook.cryptomus';

export interface AllowedRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  id: RouteId;
}

/**
 * Exact-match allowlist. There is deliberately no catch-all passthrough to
 * OmniRoute: a path that is not listed here never reaches upstream. Console
 * routes are served locally and never proxied.
 */
export const PUBLIC_ALLOWLIST: readonly AllowedRoute[] = Object.freeze([
  { method: 'GET', pattern: /^\/health\/live$/, id: 'health.live' },
  { method: 'GET', pattern: /^\/health\/ready$/, id: 'health.ready' },
  { method: 'GET', pattern: /^\/v1\/models$/, id: 'models.list' },
  { method: 'POST', pattern: /^\/v1\/chat\/completions$/, id: 'chat.completions' },
  { method: 'POST', pattern: /^\/v1\/responses$/, id: 'responses.create' },
  { method: 'POST', pattern: /^\/v1\/messages$/, id: 'messages.create' },
  { method: 'POST', pattern: /^\/v1\/messages\/count_tokens$/, id: 'messages.count_tokens' },

  { method: 'GET', pattern: /^\/(admin|member|chat|login)$/, id: 'console.page' },
  { method: 'GET', pattern: /^\/console\/assets\/[A-Za-z0-9._-]{1,128}$/, id: 'console.asset' },
  { method: 'GET', pattern: /^\/console\/api\/session$/, id: 'console.auth' },
  { method: 'POST', pattern: /^\/console\/api\/auth\/(request-code|verify-code|logout)$/, id: 'console.auth' },
  { method: 'GET', pattern: /^\/console\/api\/auth\/start\/(google|discord)$/, id: 'console.auth' },
  { method: 'GET', pattern: /^\/callbacks\/(google|discord)$/, id: 'console.callback' },
  { method: 'POST', pattern: /^\/callbacks\/telegram$/, id: 'console.callback' },
  {
    method: 'GET',
    pattern: /^\/console\/api\/member\/(overview|usage|keys|payments|plans)$/,
    id: 'console.member'
  },
  {
    method: 'POST',
    pattern: /^\/console\/api\/member\/(keys|keys\/revoke|topup|subscribe)$/,
    id: 'console.member'
  },
  {
    method: 'GET',
    pattern: /^\/console\/api\/admin\/(overview|plans|models|accounts|payments)$/,
    id: 'console.admin'
  },
  {
    method: 'POST',
    pattern: /^\/console\/api\/admin\/(plans|models|accounts\/limits|accounts\/credit|accounts\/status)$/,
    id: 'console.admin'
  },
  { method: 'POST', pattern: /^\/webhooks\/cryptomus$/, id: 'webhook.cryptomus' }
]);

export function resolveRoute(method: string, path: string): RouteId | null {
  return (
    PUBLIC_ALLOWLIST.find((route) => route.method === method && route.pattern.test(path))?.id ?? null
  );
}

const CONSOLE_ROUTES = new Set<RouteId>([
  'console.page',
  'console.asset',
  'console.auth',
  'console.callback',
  'console.member',
  'console.admin',
  'webhook.cryptomus'
]);

/** Console traffic is served locally and must never enter the upstream path. */
export function isConsoleRoute(id: RouteId): boolean {
  return CONSOLE_ROUTES.has(id);
}
