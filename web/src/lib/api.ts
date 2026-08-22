export interface Plan {
  id: string;
  name: string;
  monthlyPriceCents: number;
  includedTokens: number;
  overageCentsPerMillion: number;
  maxConcurrent: number;
  rateLimitRpm: number;
  dailyBudgetUnits: number;
  models: string[];
  active: boolean;
  /** The model group the plan entitles. Read/written with the row. */
  modelGroupId?: string | null;
  /** Release 2 purchase fields; the backend supplies defaults when absent. */
  priceCents?: number;
  durationHours?: number | null;
  timerBasis?: 'from_payment' | 'from_first_use';
  resetsAllowed?: number;
  method?: PlanMethod;
  tierLabel?: string;
  /** Models this plan's group entitles, with the group multiplier applied. */
  eligibleModels?: EligibleModel[];
}

export type PlanMethod = 'rolling_time' | 'token_pack' | 'monetary_pack' | 'payg';

/**
 * One model a plan's group entitles, exactly as the member plans endpoint
 * projects it: the group multiplier is already applied to the effective
 * prices, and the upstream name is deliberately absent. Optional because
 * older deployments may not have run the projection yet.
 */
export interface EligibleModel {
  id: string;
  name: string;
  provider: string;
  multimodalSupport: boolean;
  inputPriceCents: number;
  outputPriceCents: number;
  cacheReadPriceCents: number;
  effectiveInputPriceCents: number;
  effectiveOutputPriceCents: number;
  effectiveCacheReadPriceCents: number;
}

/**
 * One row of the admin bulk model edit: the id names the catalog entry, every
 * other field is a partial update applied in the same transaction as the rest
 * of the batch. The server validates the same bounds as the single-model
 * editor, so a row the editor would reject is rejected here too.
 */
export interface BulkModelRow {
  id: string;
  inputPriceCents?: number;
  outputPriceCents?: number;
  cacheReadPriceCents?: number;
  enabled?: boolean;
  groupId?: string;
  upstreamModel?: string;
}

export interface Subscription {
  id: string;
  planId: string;
  status: 'active' | 'past_due' | 'canceled';
  periodStart: string;
  periodEnd: string;
  includedTokens: number;
  usedTokens: number;
  autoRenew: boolean;
}

/** One live subscription as listed by the member subscriptions endpoint. */
export interface SubscriptionInfo {
  id: string;
  planId: string;
  planName: string;
  tierLabel: string;
  status: string;
  method: string | null;
  includedTokens: number;
  usedTokens: number;
  durationHours: number | null;
  timerBasis: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  resetsRemaining: number;
}

export interface BillingSummary {
  plan: Plan | null;
  subscription: Subscription | null;
  walletTokens: number;
  subscriptionRemaining: number;
  totalAvailable: number;
  funded: boolean;
  usageToday: number;
  usageThisPeriod: number;
  projectedDaysLeft: number | null;
}

export interface TenantLimits {
  dailyBudgetUnits: number;
  maxConcurrent: number;
  rateLimitRpm: number;
}

export interface ModelInput {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'google' | 'meta' | 'other';
  inputPriceCents: number;
  outputPriceCents: number;
  cacheReadPriceCents: number;
  multimodalSupport: boolean;
  upstreamModel: string;
  enabled?: boolean;
  /** Model group to place the model in; defaults to legacy-default on create. */
  groupId?: string;
}

export type ModelUpdate = Partial<Omit<ModelInput, 'id'>>;

export interface ModelRecord extends Omit<ModelInput, 'enabled'> {
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the gateway will actually enforce for a tenant. `stored` is false when no
 * `tenant_limits` row exists yet and the values are the process defaults, so the
 * editor can say which it is showing.
 */
export interface EffectiveTenantLimits extends TenantLimits {
  stored: boolean;
}

export interface LedgerEntry {
  id: string;
  kind: string;
  source: string;
  tokens: number;
  reference: string;
  balanceAfter: number;
  createdAt: string;
}

/**
 * One settled request as shown in the member usage ledger (console phase B).
 * Token splits are null when upstream reported only totals, and `costCentsEst`
 * is null when the model price is unknown — the UI must label it an estimate
 * and never render a fabricated cost.
 */
export interface UsageRecent {
  requestId: string;
  at: string;
  model: string | null;
  units: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  thinkingTokens: number | null;
  durationMs: number | null;
  finishReason: string | null;
  appLabel: string | null;
  costCentsEst: number | null;
}

export interface SessionState {
  authenticated: boolean;
  account: {
    email: string;
    display_name: string;
    role: string;
    tenant_id: string;
    has_password: boolean;
  } | null;
  providers: {
    google: boolean;
    discord: boolean;
    telegram: boolean;
    telegram_bot: string | null;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * One request helper for the whole console. Errors are normalised here so no
 * screen has to guess whether a failure arrived as JSON, HTML, or a dropped
 * connection.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init
    });
  } catch {
    throw new ApiError('network_error', 0, 'Network unavailable. Check your connection.');
  }

  // A failing edge or an unbuilt console answers with HTML, not JSON. Parsing
  // outside this guard used to throw a raw SyntaxError, which defeated every
  // `instanceof ApiError` branch — including the 401 redirect to /login.
  const text = await response.text();
  let payload: unknown = {};
  let parsed = true;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      parsed = false;
    }
  }

  // Status first: a 401 delivered as an HTML page must still arrive as an
  // ApiError carrying that status.
  if (!response.ok) {
    const detail = parsed
      ? (payload as { error?: { code?: string; message?: string } }).error
      : undefined;
    throw new ApiError(
      detail?.code ?? 'request_failed',
      response.status,
      detail?.message ?? 'Request failed'
    );
  }
  if (!parsed) {
    throw new ApiError(
      'invalid_response',
      response.status,
      'The server returned a response this page could not read.'
    );
  }
  return payload as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  session: () => get<SessionState>('/console/api/session'),
  requestCode: (email: string) =>
    post<{ delivered: boolean; ttl_minutes: number; dev_code?: string }>(
      '/console/api/auth/request-code',
      { email }
    ),
  verifyCode: (email: string, code: string) =>
    post<{ authenticated: boolean; role: string }>('/console/api/auth/verify-code', {
      email,
      code
    }),
  register: (input: { name: string; email: string; password: string; confirmPassword: string }) =>
    post<{ delivered: boolean; ttl_minutes: number; dev_code?: string }>(
      '/console/api/auth/register',
      input
    ),
  registerVerify: (email: string, code: string) =>
    post<{ authenticated: boolean; role: string }>('/console/api/auth/register/verify', {
      email,
      code
    }),
  loginPassword: (email: string, password: string) =>
    post<{ delivered: boolean; ttl_minutes: number; dev_code?: string }>(
      '/console/api/auth/login/password',
      { email, password }
    ),
  loginVerify: (email: string, code: string) =>
    post<{ authenticated: boolean; role: string }>('/console/api/auth/login/verify', {
      email,
      code
    }),
  requestReset: (email: string) =>
    post<{ delivered: boolean; ttl_minutes: number }>(
      '/console/api/auth/password/request-reset',
      { email }
    ),
  resetPassword: (input: { email: string; code: string; password: string; confirmPassword: string }) =>
    post<{ reset: boolean }>('/console/api/auth/password/reset', input),
  setPassword: (input: { password: string; confirmPassword: string }) =>
    post<{ set: boolean }>('/console/api/auth/password/set', input),
  logout: () => post<{ authenticated: boolean }>('/console/api/auth/logout'),

  member: {
    overview: () =>
      get<{
        account: { email: string; display_name: string; role: string; has_password: boolean };
        billing: BillingSummary;
        ledger: LedgerEntry[];
      }>('/console/api/member/overview'),
    usage: () =>
      get<{ days: Array<{ day: string; units: number }>; recent: UsageRecent[] }>(
        '/console/api/member/usage'
      ),
    plans: () => get<{ plans: Plan[] }>('/console/api/member/plans'),
    keys: () =>
      get<{
        keys: Array<{
          id: string;
          name: string;
          prefix: string;
          last4: string;
          scopes: string[];
          createdAt: string;
          revokedAt: string | null;
        }>;
      }>('/console/api/member/keys'),
    createKey: (name: string, scopes: string[]) =>
      post<{ key: string }>('/console/api/member/keys', { name, scopes }),
    revokeKey: (keyId: string) => post<{ revoked: boolean }>('/console/api/member/keys/revoke', { keyId }),
    /**
     * Rotates a key: mints a replacement and retires the old one after a grace
     * window (default 30 minutes) so a live caller can migrate without a gap.
     * The plaintext is returned once, exactly like a freshly issued key.
     */
    rotateKey: (keyId: string, graceMinutes?: number) =>
      post<{ key: string; key_id: string; grace_minutes: number }>(
        '/console/api/member/keys/rotate',
        graceMinutes === undefined ? { keyId } : { keyId, graceMinutes }
      ),
    payments: () =>
      get<{ payments: Array<Record<string, string | number | null>> }>('/console/api/member/payments'),
    subscribe: (planId: string) =>
      post<{ payment_url?: string; subscription?: Subscription }>('/console/api/member/subscribe', {
        planId
      }),
    topup: (planId: string, amountCents: number) =>
      post<{ payment_url: string; tokens: number }>('/console/api/member/topup', {
        planId,
        amountCents
      }),
    /** Custom token pack: any whole-million quantity with a chosen shelf life. */
    customTopup: (planId: string, tokenQuantity: number, durationHours: number) =>
      post<{ payment_url: string; tokens: number; order_id: string }>(
        '/console/api/member/custom-topup',
        { planId, tokenQuantity, durationHours }
      ),
    /** Every live subscription, including stacked token packs. */
    subscriptions: () =>
      get<{ subscriptions: SubscriptionInfo[] }>('/console/api/member/subscriptions'),
    resetSubscription: (subscriptionId: string) =>
      post<{ subscription: Subscription }>('/console/api/member/subscription/reset', {
        subscriptionId
      })
  },

  admin: {
    overview: () =>
      get<{
        totals: {
          accounts: number;
          active_subscriptions: number;
          wallet_tokens: number;
          units_today: number;
        };
        revenue_cents: number;
      }>('/console/api/admin/overview'),
    plans: () => get<{ plans: Plan[] }>('/console/api/admin/plans'),
    savePlan: (plan: Omit<Plan, 'active'> & { active?: boolean }) =>
      post<{ plan: Plan }>('/console/api/admin/plans', plan),
    models: () =>
      get<{
        catalog: Array<{
          id: string;
          name: string;
          provider: string;
          inputPriceCents: number;
          outputPriceCents: number;
          cacheReadPriceCents: number;
          multimodalSupport: boolean;
          upstreamModel: string;
          enabled: boolean;
          groupId: string | null;
        }>;
        policies: Array<{ tenant_id: string; model_id: string; enabled: number }>;
      }>('/console/api/admin/models'),
    createModel: (input: ModelInput) =>
      post<{ model: ModelRecord }>('/console/api/admin/models', input),
    updateModel: (id: string, input: ModelUpdate) =>
      request<{ model: ModelRecord }>(`/console/api/admin/models/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(input)
      }),
    deleteModel: (id: string) =>
      request<{ deleted: boolean }>(`/console/api/admin/models/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }),
    syncModels: (options: { reset?: boolean } = {}) =>
      post<{ synced: boolean; added: string[]; skipped: number; removed: string[]; keptProtected: string[]; reset: boolean }>('/console/api/admin/models/sync', options),
    /**
     * Applies one partial update per listed model inside a single transaction.
     * Unknown ids come back in `missing` rather than failing the batch; a row
     * that fails validation rejects the whole payload before anything lands.
     */
    bulkUpdateModels: (rows: BulkModelRow[]) =>
      post<{ updated: string[]; missing: string[] }>('/console/api/admin/models/bulk', { rows }),
    setModelPolicy: (tenantId: string, modelId: string, enabled: boolean) =>
      post<{ updated: boolean }>('/console/api/admin/models/policy', { tenantId, modelId, enabled }),
    modelGroups: () =>
      get<{
        groups: Array<{
          id: string;
          name: string;
          multiplierBps: number;
          enabled: boolean;
          modelsCount: number;
          activeModelsCount: number;
          plansCount: number;
        }>;
      }>('/console/api/admin/model-groups'),
    accounts: () =>
      get<{
        accounts: Array<{
          id: string;
          email: string;
          displayName: string;
          role: string;
          status: string;
          tenantId: string;
          billing: BillingSummary;
          limits: EffectiveTenantLimits;
        }>;
      }>('/console/api/admin/accounts'),
    setLimits: (input: {
      tenantId: string;
      dailyBudgetUnits: number;
      maxConcurrent: number;
      rateLimitRpm: number;
    }) => post<{ updated: boolean }>('/console/api/admin/accounts/limits', input),
    credit: (accountId: string, tokens: number, reason: string) =>
      post<{ balance_tokens: number }>('/console/api/admin/accounts/credit', {
        accountId,
        tokens,
        reason
      }),
    setStatus: (accountId: string, status: 'active' | 'suspended') =>
      post<{ updated: boolean }>('/console/api/admin/accounts/status', { accountId, status }),
    payments: () =>
      get<{ payments: Array<Record<string, string | number | null>> }>('/console/api/admin/payments')
  }
};
