export type RouteId =
  | 'health.live'
  | 'health.ready'
  | 'metrics.read'
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
  { method: 'GET', pattern: /^\/metrics$/, id: 'metrics.read' },
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

export interface DocumentedOperation {
  method: 'GET' | 'POST';
  /** Path exactly as it appears in docs/api/openapi.yaml. */
  path: string;
  /** Concrete path proving the allowlist still accepts this operation. */
  sample: string;
  id: RouteId;
}

/**
 * The published surface, expanded one entry per operation. The allowlist uses
 * alternation for compactness, which is unreadable as an API contract, so the
 * expansion lives here and a test keeps it, the allowlist, and the OpenAPI
 * document in agreement. An undocumented route therefore fails CI.
 */
export const DOCUMENTED_OPERATIONS: readonly DocumentedOperation[] = Object.freeze([
  { method: 'GET', path: '/health/live', sample: '/health/live', id: 'health.live' },
  { method: 'GET', path: '/health/ready', sample: '/health/ready', id: 'health.ready' },
  { method: 'GET', path: '/metrics', sample: '/metrics', id: 'metrics.read' },
  { method: 'GET', path: '/v1/models', sample: '/v1/models', id: 'models.list' },
  { method: 'POST', path: '/v1/chat/completions', sample: '/v1/chat/completions', id: 'chat.completions' },
  { method: 'POST', path: '/v1/responses', sample: '/v1/responses', id: 'responses.create' },
  { method: 'POST', path: '/v1/messages', sample: '/v1/messages', id: 'messages.create' },
  { method: 'POST', path: '/v1/messages/count_tokens', sample: '/v1/messages/count_tokens', id: 'messages.count_tokens' },
  { method: 'GET', path: '/admin', sample: '/admin', id: 'console.page' },
  { method: 'GET', path: '/member', sample: '/member', id: 'console.page' },
  { method: 'GET', path: '/chat', sample: '/chat', id: 'console.page' },
  { method: 'GET', path: '/login', sample: '/login', id: 'console.page' },
  { method: 'GET', path: '/console/assets/{file}', sample: '/console/assets/member.js', id: 'console.asset' },
  { method: 'GET', path: '/console/api/session', sample: '/console/api/session', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/request-code', sample: '/console/api/auth/request-code', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/verify-code', sample: '/console/api/auth/verify-code', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/logout', sample: '/console/api/auth/logout', id: 'console.auth' },
  { method: 'GET', path: '/console/api/auth/start/{provider}', sample: '/console/api/auth/start/google', id: 'console.auth' },
  { method: 'GET', path: '/callbacks/{provider}', sample: '/callbacks/google', id: 'console.callback' },
  { method: 'POST', path: '/callbacks/telegram', sample: '/callbacks/telegram', id: 'console.callback' },
  { method: 'GET', path: '/console/api/member/overview', sample: '/console/api/member/overview', id: 'console.member' },
  { method: 'GET', path: '/console/api/member/usage', sample: '/console/api/member/usage', id: 'console.member' },
  { method: 'GET', path: '/console/api/member/keys', sample: '/console/api/member/keys', id: 'console.member' },
  { method: 'GET', path: '/console/api/member/payments', sample: '/console/api/member/payments', id: 'console.member' },
  { method: 'GET', path: '/console/api/member/plans', sample: '/console/api/member/plans', id: 'console.member' },
  { method: 'POST', path: '/console/api/member/keys', sample: '/console/api/member/keys', id: 'console.member' },
  { method: 'POST', path: '/console/api/member/keys/revoke', sample: '/console/api/member/keys/revoke', id: 'console.member' },
  { method: 'POST', path: '/console/api/member/topup', sample: '/console/api/member/topup', id: 'console.member' },
  { method: 'POST', path: '/console/api/member/subscribe', sample: '/console/api/member/subscribe', id: 'console.member' },
  { method: 'GET', path: '/console/api/admin/overview', sample: '/console/api/admin/overview', id: 'console.admin' },
  { method: 'GET', path: '/console/api/admin/plans', sample: '/console/api/admin/plans', id: 'console.admin' },
  { method: 'GET', path: '/console/api/admin/models', sample: '/console/api/admin/models', id: 'console.admin' },
  { method: 'GET', path: '/console/api/admin/accounts', sample: '/console/api/admin/accounts', id: 'console.admin' },
  { method: 'GET', path: '/console/api/admin/payments', sample: '/console/api/admin/payments', id: 'console.admin' },
  { method: 'POST', path: '/console/api/admin/plans', sample: '/console/api/admin/plans', id: 'console.admin' },
  { method: 'POST', path: '/console/api/admin/models', sample: '/console/api/admin/models', id: 'console.admin' },
  { method: 'POST', path: '/console/api/admin/accounts/limits', sample: '/console/api/admin/accounts/limits', id: 'console.admin' },
  { method: 'POST', path: '/console/api/admin/accounts/credit', sample: '/console/api/admin/accounts/credit', id: 'console.admin' },
  { method: 'POST', path: '/console/api/admin/accounts/status', sample: '/console/api/admin/accounts/status', id: 'console.admin' },
  { method: 'POST', path: '/webhooks/cryptomus', sample: '/webhooks/cryptomus', id: 'webhook.cryptomus' }
]);

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

/**
 * Console surfaces whose authority comes from something a browser attaches
 * automatically: the session cookie, or the Cloudflare Access assertion added
 * at the edge. A state change on these needs proof of origin. Third-party
 * callbacks are excluded because they legitimately arrive cross-site and prove
 * themselves with a signature or a one-time state value instead.
 */
const ORIGIN_PROTECTED_ROUTES = new Set<RouteId>([
  'console.auth',
  'console.member',
  'console.admin'
]);

export function requiresTrustedOrigin(id: RouteId): boolean {
  return ORIGIN_PROTECTED_ROUTES.has(id);
}
