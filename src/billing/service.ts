import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { effectiveCents } from './pricing.js';

export class BillingError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
    this.name = 'BillingError';
  }
}

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
  modelGroupId?: string | null;
  active: boolean;
  /** Release 2 (spec 20.1): subscription purchase metadata, always populated
   * by toPlan; optional in the input so legacy callers stay valid. */
  priceCents?: number;
  durationHours?: number | null;
  timerBasis?: 'from_payment' | 'from_first_use';
  resetsAllowed?: number;
  method?: 'rolling_time' | 'token_pack' | 'monetary_pack' | 'payg';
  tierLabel?: string;
}

export interface Subscription {
  id: string;
  accountId: string;
  planId: string;
  status: 'active' | 'past_due' | 'canceled';
  periodStart: string;
  periodEnd: string;
  includedTokens: number;
  usedTokens: number;
  autoRenew: boolean;
  /** Release 2 (spec 20.1): snapshot of the plan at purchase time. */
  method: 'rolling_time' | 'token_pack' | 'monetary_pack' | null;
  durationHours: number | null;
  timerBasis: 'from_payment' | 'from_first_use' | null;
  activatedAt: string | null;
  expiresAt: string | null;
  resetsRemaining: number;
  modelGroupId: string | null;
}

export interface LedgerEntry {
  id: string;
  kind: string;
  source: string;
  tokens: number;
  reference: string;
  balanceAfter: number;
  currency: 'tokens' | 'cents';
  cents: number;
  balanceAfterCents: number;
  createdAt: string;
}

export interface BillingSummary {
  plan: Plan | null;
  subscription: Subscription | null;
  walletTokens: number;
  walletCents: number;
  subscriptionRemaining: number;
  totalAvailable: number;
  funded: boolean;
  usageToday: number;
  usageThisPeriod: number;
  projectedDaysLeft: number | null;
}

interface PlanRow {
  id: string;
  name: string;
  monthly_price_cents: number;
  included_tokens: number;
  overage_cents_per_million: number;
  max_concurrent: number;
  rate_limit_rpm: number;
  daily_budget_units: number;
  models_json: string;
  model_group_id: string | null;
  active: number;
  price_cents: number;
  duration_hours: number | null;
  timer_basis: 'from_payment' | 'from_first_use';
  resets_allowed: number;
  method: 'rolling_time' | 'token_pack' | 'monetary_pack' | 'payg';
  tier_label: string;
}

interface SubscriptionRow {
  id: string;
  account_id: string;
  plan_id: string;
  status: 'active' | 'past_due' | 'canceled';
  period_start: string;
  period_end: string;
  included_tokens: number;
  used_tokens: number;
  auto_renew: number;
  method: 'rolling_time' | 'token_pack' | 'monetary_pack' | null;
  duration_hours: number | null;
  timer_basis: 'from_payment' | 'from_first_use' | null;
  activated_at: string | null;
  expires_at: string | null;
  resets_remaining: number;
  model_group_id: string | null;
}

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    monthlyPriceCents: row.monthly_price_cents,
    includedTokens: row.included_tokens,
    overageCentsPerMillion: row.overage_cents_per_million,
    maxConcurrent: row.max_concurrent,
    rateLimitRpm: row.rate_limit_rpm,
    dailyBudgetUnits: row.daily_budget_units,
    models: JSON.parse(row.models_json) as string[],
    modelGroupId: row.model_group_id,
    active: row.active === 1,
    priceCents: row.price_cents,
    durationHours: row.duration_hours,
    timerBasis: row.timer_basis,
    resetsAllowed: row.resets_allowed,
    method: row.method,
    tierLabel: row.tier_label
  };
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    accountId: row.account_id,
    planId: row.plan_id,
    status: row.status,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    includedTokens: row.included_tokens,
    usedTokens: row.used_tokens,
    autoRenew: row.auto_renew === 1,
    method: row.method,
    durationHours: row.duration_hours,
    timerBasis: row.timer_basis,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    resetsRemaining: row.resets_remaining,
    modelGroupId: row.model_group_id
  };
}

const RECONCILE_BATCH = 500;

/**
 * Billing is deliberately downstream of metering. `usage_events` is already the
 * settled record of what a tenant consumed, so the ledger is derived from it
 * rather than adding another write to the streaming path where a failure would
 * cost the caller their response.
 */
export class BillingService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // ---- Plans ----

  listPlans(activeOnly = false): Plan[] {
    const sql = activeOnly
      ? 'SELECT * FROM plans WHERE active = 1 ORDER BY monthly_price_cents'
      : 'SELECT * FROM plans ORDER BY monthly_price_cents';
    return (this.db.prepare(sql).all() as PlanRow[]).map(toPlan);
  }

  listMemberPlans(): Array<Plan & { modelGroupId: string | null; eligibleModels: Array<Record<string, unknown>> }> {
    const plans = this.db.prepare(`
      SELECT p.*, g.multiplier_bps
      FROM plans p LEFT JOIN model_groups g ON g.id = p.model_group_id
      WHERE p.active = 1 AND g.enabled = 1
      ORDER BY p.monthly_price_cents, p.name, p.id
    `).all() as Array<PlanRow & { model_group_id: string; multiplier_bps: number }>;
    const models = this.db.prepare(`
      SELECT public_id, display_name, provider, multimodal, input_price_cents, output_price_cents, cache_read_price_cents, group_id
      FROM models WHERE enabled = 1 AND group_id = ? ORDER BY display_name, public_id
    `);
    return plans.map((row) => ({
      ...toPlan(row),
      modelGroupId: row.model_group_id,
      eligibleModels: (models.all(row.model_group_id) as Array<Record<string, unknown>>).map((model) => ({
        id: model.public_id,
        name: model.display_name,
        provider: model.provider,
        multimodalSupport: model.multimodal === 1,
        inputPriceCents: model.input_price_cents,
        outputPriceCents: model.output_price_cents,
        cacheReadPriceCents: model.cache_read_price_cents,
        effectiveInputPriceCents: effectiveCents(model.input_price_cents as number, row.multiplier_bps),
        effectiveOutputPriceCents: effectiveCents(model.output_price_cents as number, row.multiplier_bps),
        effectiveCacheReadPriceCents: effectiveCents(model.cache_read_price_cents as number, row.multiplier_bps)
      }))
    }));
  }

  getPlan(planId: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as
      | PlanRow
      | undefined;
    return row ? toPlan(row) : null;
  }

  upsertPlan(plan: Omit<Plan, 'active'> & { active?: boolean }): Plan {
    this.db
      .prepare(
        `INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, price_cents, duration_hours, timer_basis, resets_allowed, method, tier_label, updated_at)
         VALUES (@id, @name, @price, @included, @overage, @concurrent, @rpm, @daily, @models, @active, @priceCents, @durationHours, @timerBasis, @resetsAllowed, @method, @tierLabel, @updated)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           monthly_price_cents = excluded.monthly_price_cents,
           included_tokens = excluded.included_tokens,
           overage_cents_per_million = excluded.overage_cents_per_million,
           max_concurrent = excluded.max_concurrent,
           rate_limit_rpm = excluded.rate_limit_rpm,
           daily_budget_units = excluded.daily_budget_units,
           models_json = excluded.models_json,
           active = excluded.active,
           price_cents = excluded.price_cents,
           duration_hours = excluded.duration_hours,
           timer_basis = excluded.timer_basis,
           resets_allowed = excluded.resets_allowed,
           method = excluded.method,
           tier_label = excluded.tier_label,
           updated_at = excluded.updated_at`
      )
      .run({
        id: plan.id,
        name: plan.name,
        price: plan.monthlyPriceCents,
        included: plan.includedTokens,
        overage: plan.overageCentsPerMillion,
        concurrent: plan.maxConcurrent,
        rpm: plan.rateLimitRpm,
        daily: plan.dailyBudgetUnits,
        models: JSON.stringify(plan.models),
        active: plan.active === false ? 0 : 1,
        priceCents: plan.priceCents ?? 0,
        durationHours: plan.durationHours ?? null,
        timerBasis: plan.timerBasis ?? 'from_payment',
        resetsAllowed: plan.resetsAllowed ?? 0,
        method: plan.method ?? 'token_pack',
        tierLabel: plan.tierLabel ?? '',
        updated: this.iso()
      });
    const stored = this.getPlan(plan.id);
    if (!stored) throw new BillingError('plan_write_failed', 500);
    return stored;
  }

  /** Pay-as-you-go conversion. One price list, so the UI cannot invent another. */
  tokensForCents(plan: Plan, cents: number): number {
    if (plan.overageCentsPerMillion <= 0) throw new BillingError('plan_has_no_payg_rate', 400);
    return Math.floor((cents / plan.overageCentsPerMillion) * 1_000_000);
  }

  centsForTokens(plan: Plan, tokens: number): number {
    return Math.ceil((tokens / 1_000_000) * plan.overageCentsPerMillion);
  }

  // ---- Subscriptions ----

  activeSubscription(accountId: string): Subscription | null {
    const row = this.db
      .prepare(
        "SELECT * FROM subscriptions WHERE account_id = ? AND status IN ('active','past_due') ORDER BY created_at DESC LIMIT 1"
      )
      .get(accountId) as SubscriptionRow | undefined;
    return row ? toSubscription(row) : null;
  }

  /** Release 2 (spec 11C): both methods can be active at the same time. */
  private activeSubscriptions(accountId: string): Subscription[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM subscriptions WHERE account_id = ? AND status IN ('active','past_due') ORDER BY created_at"
      )
      .all(accountId) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  /**
   * Release 2 (spec 20.3): a subscription's timer is running only once it has
   * been activated. Legacy subscriptions (no duration) stay valid until
   * period_end, which preserves the pre-Release-2 behaviour.
   */
  private windowActive(subscription: Subscription): boolean {
    if (subscription.durationHours !== null) {
      return (
        subscription.activatedAt !== null &&
        subscription.expiresAt !== null &&
        subscription.expiresAt > this.iso()
      );
    }
    return subscription.periodEnd > this.iso();
  }

  /**
   * Starting a period grants the allowance as a ledger entry, so the dashboard
   * can always explain where a token balance came from.
   *
   * Release 2 (spec 20.1/20.3): the subscription snapshots the plan's method,
   * duration, timer basis and reset budget. `from_payment` timers start now;
   * `from_first_use` stays pending until the first metered request activates
   * it atomically (see activateFirstUse).
   */
  startSubscription(accountId: string, planId: string, periodDays = 30): Subscription {
    const plan = this.getPlan(planId);
    if (!plan) throw new BillingError('plan_not_found', 404);
    if (!plan.active) throw new BillingError('plan_inactive', 409);

    const id = randomUUID();
    const start = this.iso();
    const durationHours = plan.durationHours ?? null;
    const method = plan.method ?? 'token_pack';
    const timerBasis = plan.timerBasis ?? 'from_payment';
    const durationMs = durationHours ? durationHours * 3_600_000 : null;
    const end = this.iso(durationHours ? durationMs! : periodDays * 24 * 3_600_000);
    const apply = this.db.transaction(() => {
      // Release 2 (spec 11C): both methods can be active simultaneously.
      // Buying a new Rolling Time replaces the old timer; buying a Token Pack
      // stacks on top of live packs, which is what makes the earliest-expiry
      // queue in applyUsage meaningful. Legacy plans (no duration) keep the
      // old all-or-nothing behaviour.
      if (durationHours === null) {
        this.db
          .prepare(
            "UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE account_id = ? AND status IN ('active','past_due')"
          )
          .run(start, accountId);
      } else if (method === 'rolling_time') {
        this.db
          .prepare(
            `UPDATE subscriptions SET status = 'canceled', updated_at = ?
             WHERE account_id = ? AND status IN ('active','past_due') AND method = 'rolling_time'`
          )
          .run(start, accountId);
      }
      this.db
        .prepare(
          `INSERT INTO subscriptions (id, account_id, plan_id, status, period_start, period_end, included_tokens, used_tokens, auto_renew, method, duration_hours, timer_basis, activated_at, expires_at, resets_remaining, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          accountId,
          planId,
          start,
          end,
          plan.includedTokens,
          method,
          durationHours,
          timerBasis,
          timerBasis === 'from_payment' ? start : null,
          timerBasis === 'from_payment' ? end : null,
          plan.resetsAllowed ?? 0,
          start,
          start
        );
      this.recordLedger(accountId, {
        kind: 'grant',
        source: 'subscription',
        tokens: plan.includedTokens,
        reference: id,
        balanceAfter: this.walletBalance(accountId)
      });
      this.applyPlanLimits(accountId, plan);
    });
    apply();
    const created = this.getSubscription(id);
    if (!created) throw new BillingError('subscription_write_failed', 500);
    return created;
  }

  /**
   * Release 2 (spec 20.3): first-use activation is atomic so two racing
   * requests can only produce one write. Returns the subscription fresh from
   * the database so the caller observes the winning activation.
   */
  activateFirstUse(subscriptionId: string): Subscription | null {
    const now = this.iso();
    const row = this.db
      .prepare(
        "SELECT * FROM subscriptions WHERE id = ? AND timer_basis = 'from_first_use' AND activated_at IS NULL AND status = 'active'"
      )
      .get(subscriptionId) as SubscriptionRow | undefined;
    if (!row) return this.getSubscription(subscriptionId);
    const durationMs = row.duration_hours ? row.duration_hours * 3_600_000 : 0;
    const apply = this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE subscriptions SET activated_at = ?, expires_at = ?, updated_at = ? WHERE id = ? AND activated_at IS NULL"
        )
        .run(now, this.iso(durationMs), now, subscriptionId);
      return result.changes;
    });
    apply();
    return this.getSubscription(subscriptionId);
  }

  getSubscription(subscriptionId: string): Subscription | null {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId) as
      | SubscriptionRow
      | undefined;
    return row ? toSubscription(row) : null;
  }

  /**
   * Release 2 (spec 20.3/20.4): reset restarts the timer from NOW and restores
   * the token allowance; the remaining reset budget is decremented once.
   * A reset with no budget left (or one racing another reset) is a 409.
   */
  resetSubscription(subscriptionId: string): Subscription {
    const now = this.iso();
    const row = this.db
      .prepare(
        "SELECT * FROM subscriptions WHERE id = ? AND status = 'active' AND resets_remaining > 0"
      )
      .get(subscriptionId) as SubscriptionRow | undefined;
    if (!row) throw new BillingError('subscription_reset_unavailable', 409);
    const durationMs = row.duration_hours ? row.duration_hours * 3_600_000 : 0;
    const apply = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE subscriptions SET activated_at = ?, expires_at = ?, used_tokens = 0, resets_remaining = resets_remaining - 1, updated_at = ?
           WHERE id = ? AND status = 'active' AND resets_remaining > 0`
        )
        .run(now, this.iso(durationMs), now, subscriptionId);
      if (result.changes === 0) throw new BillingError('subscription_reset_unavailable', 409);
    });
    apply();
    const reset = this.getSubscription(subscriptionId);
    if (!reset) throw new BillingError('subscription_write_failed', 500);
    return reset;
  }

  cancelSubscription(accountId: string): void {
    this.db
      .prepare(
        "UPDATE subscriptions SET status = 'canceled', auto_renew = 0, updated_at = ? WHERE account_id = ? AND status IN ('active','past_due')"
      )
      .run(this.iso(), accountId);
  }

  /** A plan is not just a price: it is the tenant's operational envelope. */
  applyPlanLimits(accountId: string, plan: Plan): void {
    const row = this.db.prepare('SELECT tenant_id FROM accounts WHERE id = ?').get(accountId) as
      | { tenant_id: string }
      | undefined;
    if (!row) throw new BillingError('account_not_found', 404);
    this.db
      .prepare(
        `INSERT INTO tenant_limits (tenant_id, daily_budget_units, max_concurrent, rate_limit_rpm, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           daily_budget_units = excluded.daily_budget_units,
           max_concurrent = excluded.max_concurrent,
           rate_limit_rpm = excluded.rate_limit_rpm,
           updated_at = excluded.updated_at`
      )
      .run(row.tenant_id, plan.dailyBudgetUnits, plan.maxConcurrent, plan.rateLimitRpm, this.iso());
    // The plan is an envelope, not an addition. Enabling only what the new plan
    // lists would leave a downgraded tenant holding a model the plan no longer
    // pays for, so entitlements outside the plan are withdrawn first.
    this.db.prepare('UPDATE model_policies SET enabled = 0 WHERE tenant_id = ?').run(row.tenant_id);
    for (const model of plan.models) {
      this.db
        .prepare(
          'INSERT INTO model_policies (tenant_id, model_id, enabled) VALUES (?, ?, 1) ON CONFLICT(tenant_id, model_id) DO UPDATE SET enabled = 1'
        )
        .run(row.tenant_id, model);
    }
  }

  // ---- Wallet and ledger ----

  walletBalance(accountId: string): number {
    const row = this.db
      .prepare('SELECT balance_tokens FROM wallets WHERE account_id = ?')
      .get(accountId) as { balance_tokens: number } | undefined;
    return row?.balance_tokens ?? 0;
  }

  /** Currency-aware balance backing monetary-pack and PAYG grants (spec: cents
   * balance is a separate ledger axis, never silently converted to tokens). */
  walletCents(accountId: string): number {
    const row = this.db
      .prepare('SELECT balance_cents FROM wallets WHERE account_id = ?')
      .get(accountId) as { balance_cents: number } | undefined;
    return row?.balance_cents ?? 0;
  }

  /**
   * Debits metered usage. Spending order (spec 20.2):
   *   1. Rolling Time allowance — FREE while the window is active;
   *   2. Token Packs — earliest expiry debited first;
   *   3. prepaid wallet tokens — PAYG fallback;
   *   4. prepaid wallet cents — the monetary-pack/PAYG fallback, priced through
   *      the conversion rate of the account's active PAYG plan so a cents
   *      balance is never left unspendable.
   */
  private applyUsage(accountId: string, units: number, reference: string): void {
    const already = this.db
      .prepare("SELECT 1 FROM ledger_entries WHERE account_id = ? AND source = 'usage' AND reference = ?")
      .get(accountId, reference);
    if (already) return;
    // A zero unit event still has to leave a mark. Reconciliation selects rows
    // that have no ledger entry, so returning silently here would keep the row
    // in the window forever and eventually crowd out billable work.
    if (units <= 0) {
      this.recordLedger(accountId, {
        kind: 'debit',
        source: 'usage',
        tokens: 0,
        reference,
        balanceAfter: this.walletBalance(accountId)
      });
      return;
    }

    let remaining = units;
    const spentSubscriptions: Subscription[] = [];

    // 1. Rolling Time: free capacity inside the window.
    const rolling = this.activeSubscriptions(accountId).find(
      (entry) => entry.method === 'rolling_time'
    );
    if (rolling) {
      // A from_first_use timer that is still pending starts on this spend.
      if (rolling.timerBasis === 'from_first_use' && rolling.activatedAt === null) {
        this.activateFirstUse(rolling.id);
      }
      const live = this.getSubscription(rolling.id) ?? rolling;
      if (this.windowActive(live)) {
        const available = Math.max(0, live.includedTokens - live.usedTokens);
        const fromRolling = Math.min(available, remaining);
        if (fromRolling > 0) {
          this.db
            .prepare('UPDATE subscriptions SET used_tokens = used_tokens + ?, updated_at = ? WHERE id = ?')
            .run(fromRolling, this.iso(), live.id);
          remaining -= fromRolling;
          spentSubscriptions.push(live);
        }
      }
    }

    // 2. Token Packs: earliest expiry debited first (spec 20.4).
    const packs = this.activeSubscriptions(accountId)
      .filter((entry) => entry.method === 'token_pack' || entry.method === null)
      .sort((a, b) => {
        const aExpiry = a.expiresAt ?? a.periodEnd;
        const bExpiry = b.expiresAt ?? b.periodEnd;
        return aExpiry.localeCompare(bExpiry);
      });
    for (const pack of packs) {
      if (remaining === 0) break;
      if (pack.timerBasis === 'from_first_use' && pack.activatedAt === null) {
        this.activateFirstUse(pack.id);
      }
      const live = this.getSubscription(pack.id) ?? pack;
      if (!this.windowActive(live)) continue;
      const available = Math.max(0, live.includedTokens - live.usedTokens);
      const fromPack = Math.min(available, remaining);
      if (fromPack > 0) {
        this.db
          .prepare('UPDATE subscriptions SET used_tokens = used_tokens + ?, updated_at = ? WHERE id = ?')
          .run(fromPack, this.iso(), live.id);
        remaining -= fromPack;
        spentSubscriptions.push(live);
      }
    }

    // 3. Prepaid wallet (PAYG): tokens first, then cents priced at the active
    // PAYG rate so monetary-pack grants stay spendable on the request path.
    const wallet = this.walletBalance(accountId);
    const fromWallet = Math.min(wallet, remaining);
    const balanceAfter = wallet - fromWallet;
    if (fromWallet > 0) {
      this.db
        .prepare('UPDATE wallets SET balance_tokens = ?, updated_at = ? WHERE account_id = ?')
        .run(balanceAfter, this.iso(), accountId);
      remaining -= fromWallet;
    }

    let balanceCentsAfter = this.walletCents(accountId);
    let spentCents = 0;
    if (remaining > 0 && balanceCentsAfter > 0) {
      const ratePlan = this.paygRatePlan(accountId);
      if (ratePlan) {
        const centsForRemaining = this.centsForTokens(ratePlan, remaining);
        spentCents = Math.min(balanceCentsAfter, centsForRemaining);
        const coveredTokens = this.tokensForCents(ratePlan, spentCents);
        balanceCentsAfter = balanceCentsAfter - spentCents;
        if (spentCents > 0) {
          this.db
            .prepare('UPDATE wallets SET balance_cents = ?, updated_at = ? WHERE account_id = ?')
            .run(balanceCentsAfter, this.iso(), accountId);
          remaining -= Math.min(coveredTokens, remaining);
        }
      }
    }

    this.recordLedger(accountId, {
      kind: 'debit',
      source: 'usage',
      tokens: -(units - remaining),
      reference,
      balanceAfter,
      currency: spentCents > 0 ? 'cents' : 'tokens',
      cents: spentCents,
      balanceAfterCents: balanceCentsAfter
    });

    if (remaining > 0) {
      this.recordLedger(accountId, {
        kind: 'adjustment',
        source: 'usage',
        tokens: -remaining,
        reference: reference + ':unfunded',
        balanceAfter,
        currency: spentCents > 0 ? 'cents' : 'tokens',
        cents: 0,
        balanceAfterCents: balanceCentsAfter
      });
      const now = this.iso();
      const spentIds = spentSubscriptions.map((entry) => entry.id);
      const mark = this.db.prepare(
        "UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ? AND status IN ('active','past_due')"
      );
      if (spentIds.length > 0) {
        for (const id of spentIds) mark.run(now, id);
      } else {
        // Nothing consumed (e.g. all windows expired): mark the newest active
        // subscription so the dashboard still points at the shortfall.
        const latest = this.activeSubscription(accountId);
        if (latest) mark.run(now, latest.id);
      }
    }
  }

  /**
   * The PAYG conversion plan used to price cents spending: the active plan of
   * the account that carries an overage rate, preferring one that explicitly
   * charges per-million. A cents balance without any rate stays untouched and
   * the shortfall is recorded, so money is never silently lost or invented.
   */
  private paygRatePlan(accountId: string): Plan | null {
    for (const subscription of this.activeSubscriptions(accountId)) {
      const plan = this.getPlan(subscription.planId);
      if (plan && plan.overageCentsPerMillion > 0) return plan;
    }
    return null;
  }

  private recordLedger(
    accountId: string,
    entry: {
      kind: LedgerEntry['kind'];
      source: LedgerEntry['source'];
      tokens: number;
      reference: string;
      balanceAfter: number;
      currency?: 'tokens' | 'cents';
      cents?: number;
      balanceAfterCents?: number;
    }
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger_entries (id, account_id, kind, source, tokens, reference, balance_after, created_at, currency, cents, balance_after_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        accountId,
        entry.kind,
        entry.source,
        entry.tokens,
        entry.reference,
        entry.balanceAfter,
        this.iso(),
        entry.currency ?? 'tokens',
        entry.cents ?? 0,
        entry.balanceAfterCents ?? 0
      );
  }

  /** Credits are idempotent on (source, reference) so a webhook retry is free. */
  credit(
    accountId: string,
    tokens: number,
    source: 'payment' | 'admin' | 'payg',
    reference: string,
    kind: 'purchase' | 'adjustment' | 'refund' = 'purchase'
  ): number {
    if (tokens <= 0) throw new BillingError('credit_must_be_positive', 400);
    const apply = this.db.transaction(() => {
      const already = this.db
        .prepare(
          'SELECT 1 FROM ledger_entries WHERE account_id = ? AND source = ? AND reference = ?'
        )
        .get(accountId, source, reference);
      if (already) return this.walletBalance(accountId);
      const balance = this.walletBalance(accountId) + tokens;
      this.db
        .prepare(
          'INSERT INTO wallets (account_id, balance_tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET balance_tokens = excluded.balance_tokens, updated_at = excluded.updated_at'
        )
        .run(accountId, balance, this.iso());
      this.recordLedger(accountId, {
        kind,
        source,
        tokens,
        reference,
        balanceAfter: balance
      });
      return balance;
    });
    return apply();
  }

  settlePaymentSnapshot(
    accountId: string,
    paymentId: string,
    snapshot: {
      method?: 'rolling_time' | 'token_pack' | 'monetary_pack' | 'payg';
      planId?: string;
      modelGroupId?: string | null;
      tokens?: number;
      balanceCents?: number;
      amountCents?: number;
    }
  ): { tokensGranted: number; centsGranted: number; subscription: Subscription | null } {
    const method = snapshot.method;
    const reference = paymentId;
    if (!method || !['rolling_time', 'token_pack', 'monetary_pack', 'payg'].includes(method)) throw new BillingError('payment_method_invalid', 409);
    const payment = this.db.prepare('SELECT account_id, order_id FROM payments WHERE id = ?').get(paymentId) as { account_id: string; order_id: string } | undefined;
    if (!payment || payment.account_id !== accountId || !payment.order_id) throw new BillingError('payment_scope_invalid', 409);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT currency FROM ledger_entries WHERE account_id = ? AND source = 'payment' AND reference = ?").get(accountId, reference) as { currency: string } | undefined;
      if (existing) return { tokensGranted: 0, centsGranted: 0, subscription: null };
      if (method === 'rolling_time') {
        if (!snapshot.planId) throw new BillingError('payment_plan_missing', 409);
        const subscription = this.startSubscription(accountId, snapshot.planId);
        if (snapshot.modelGroupId !== undefined) {
          this.db.prepare('UPDATE subscriptions SET model_group_id = ?, updated_at = ? WHERE id = ?').run(snapshot.modelGroupId, this.iso(), subscription.id);
          subscription.modelGroupId = snapshot.modelGroupId;
        }
        this.db.prepare("INSERT INTO ledger_entries (id, account_id, kind, source, tokens, reference, balance_after, created_at, currency, cents, balance_after_cents) VALUES (?, ?, 'grant', 'payment', 0, ?, ?, ?, 'tokens', 0, 0)").run(randomUUID(), accountId, reference, this.walletBalance(accountId), this.iso());
        return { tokensGranted: 0, centsGranted: 0, subscription };
      }
      const tokens = snapshot.tokens ?? 0;
      const cents = snapshot.balanceCents ?? 0;
      if (!Number.isInteger(tokens) || !Number.isInteger(cents) || tokens < 0 || cents < 0) throw new BillingError('payment_amount_invalid', 409);
      if (method === 'token_pack') {
        if (tokens <= 0) throw new BillingError('payment_tokens_missing', 409);
        this.credit(accountId, tokens, 'payment', reference, 'purchase');
        const equivalentCents = snapshot.amountCents ?? cents;
        if (!Number.isInteger(equivalentCents) || equivalentCents < 0) throw new BillingError('payment_amount_invalid', 409);
        this.db.prepare("UPDATE ledger_entries SET cents = ?, currency = 'tokens' WHERE account_id = ? AND source = 'payment' AND reference = ?").run(equivalentCents, accountId, reference);
        return { tokensGranted: tokens, centsGranted: 0, subscription: null };
      }
      if ((method === 'monetary_pack' || method === 'payg') && !this.paygRatePlan(accountId)) {
        throw new BillingError('payg_rate_missing', 409);
      }
      if (cents <= 0) throw new BillingError('payment_cents_missing', 409);
      this.db.prepare('INSERT INTO wallets (account_id, balance_tokens, balance_cents, updated_at) VALUES (?, 0, ?, ?) ON CONFLICT(account_id) DO UPDATE SET balance_cents = wallets.balance_cents + excluded.balance_cents, updated_at = excluded.updated_at').run(accountId, cents, this.iso());
      this.db.prepare("INSERT INTO ledger_entries (id, account_id, kind, source, tokens, reference, balance_after, created_at, currency, cents, balance_after_cents) VALUES (?, ?, 'grant', 'payment', 0, ?, ?, ?, 'cents', ?, (SELECT balance_cents FROM wallets WHERE account_id = ?))").run(randomUUID(), accountId, reference, this.walletBalance(accountId), this.iso(), cents, accountId);
      return { tokensGranted: 0, centsGranted: cents, subscription: null };
    })();
  }

  ledger(accountId: string, limit = 50): LedgerEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, kind, source, tokens, reference, balance_after, currency, cents, balance_after_cents, created_at FROM ledger_entries WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(accountId, limit) as Array<{
      id: string;
      kind: string;
      source: string;
      tokens: number;
      reference: string;
      balance_after: number;
      currency: 'tokens' | 'cents';
      cents: number;
      balance_after_cents: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      source: row.source,
      tokens: row.tokens,
      reference: row.reference,
      balanceAfter: row.balance_after,
      currency: row.currency as 'tokens' | 'cents',
      cents: row.cents,
      balanceAfterCents: row.balance_after_cents,
      createdAt: row.created_at
    }));
  }

  // ---- Metering ----

  /**
   * Pulls settled metering rows into the ledger. Safe to call on every read.
   *
   * The cursor is an optimisation, not the correctness boundary. Two rows can
   * share a millisecond, and a strict `created_at >` comparison silently
   * dropped whichever arrived after the watermark had already moved past it.
   * Selecting rows that carry no ledger entry makes the ledger itself the
   * record of what has been billed, so a row can be late without being free.
   */
  reconcile(accountId: string, tenantId: string): void {
    const cursor = this.db
      .prepare('SELECT last_usage_at FROM billing_cursors WHERE account_id = ?')
      .get(accountId) as { last_usage_at: string } | undefined;
    const since = cursor?.last_usage_at ?? '1970-01-01T00:00:00.000Z';
    const rows = this.db
      .prepare(
        `SELECT u.id AS id, u.units AS units, u.created_at AS created_at
           FROM usage_events u
          WHERE u.tenant_id = ?
            AND u.state = 'settled'
            AND u.created_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries l
               WHERE l.account_id = ?
                 AND l.source = 'usage'
                 AND l.reference = u.id
            )
          ORDER BY u.created_at, u.id
          LIMIT ?`
      )
      .all(tenantId, since, accountId, RECONCILE_BATCH) as Array<{
      id: string;
      units: number;
      created_at: string;
    }>;
    if (rows.length === 0) return;

    const apply = this.db.transaction(() => {
      let watermark = since;
      for (const row of rows) {
        this.applyUsage(accountId, row.units, row.id);
        if (row.created_at > watermark) watermark = row.created_at;
      }
      this.db
        .prepare(
          'INSERT INTO billing_cursors (account_id, last_usage_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET last_usage_at = excluded.last_usage_at'
        )
        .run(accountId, watermark);
    });
    apply();
  }

  summary(accountId: string, tenantId: string): BillingSummary {
    this.reconcile(accountId, tenantId);
    const subscription = this.activeSubscription(accountId);
    const plan = subscription ? this.getPlan(subscription.planId) : null;
    const walletTokens = this.walletBalance(accountId);
    const walletCents = this.walletCents(accountId);
    const subscriptionRemaining = subscription
      ? Math.max(0, subscription.includedTokens - subscription.usedTokens)
      : 0;
    const day = this.iso().slice(0, 10);
    const today = this.db
      .prepare(
        "SELECT COALESCE(SUM(units), 0) AS total FROM usage_events WHERE tenant_id = ? AND state = 'settled' AND day = ?"
      )
      .get(tenantId, day) as { total: number };
    const period = subscription
      ? (this.db
          .prepare(
            "SELECT COALESCE(SUM(units), 0) AS total FROM usage_events WHERE tenant_id = ? AND state = 'settled' AND created_at >= ?"
          )
          .get(tenantId, subscription.periodStart) as { total: number })
      : { total: 0 };

    const totalAvailable = subscriptionRemaining + walletTokens;
    const burnPerDay = today.total;
    // Monetary-pack/PAYG wallets fund requests too, so they count as capacity.
    const funded = totalAvailable > 0 || walletCents > 0;
    const projectedDaysLeft =
      burnPerDay > 0 && totalAvailable > 0 ? Math.floor(totalAvailable / burnPerDay) : null;
    return {
      plan,
      subscription,
      walletTokens,
      walletCents,
      subscriptionRemaining,
      totalAvailable,
      funded,
      usageToday: today.total,
      usageThisPeriod: period.total,
      projectedDaysLeft
    };
  }

  /**
   * Cheap gate for the request path: reconcile, then refuse an account with no
   * capacity anywhere. Release 2 (spec 20.5): a live Rolling Time window funds
   * requests for free, a pending from_first_use timer funds them once the first
   * request activates it, and remaining pack allowance counts like the wallet.
   * A cents balance also satisfies the gate: it is spendable through the active
   * PAYG rate, so treating it as unfunded would strand paid money.
   */
  assertFunded(accountId: string, tenantId: string): void {
    this.reconcile(accountId, tenantId);
    for (const subscription of this.activeSubscriptions(accountId)) {
      if (subscription.timerBasis === 'from_first_use' && subscription.activatedAt === null) {
        return; // the first request activates the timer and then spends inside it
      }
      if (!this.windowActive(subscription)) continue;
      const remaining = Math.max(0, subscription.includedTokens - subscription.usedTokens);
      if (remaining > 0) return;
    }
    if (this.walletBalance(accountId) <= 0 && this.walletCents(accountId) <= 0) {
      throw new BillingError('insufficient_tokens', 402);
    }
  }
}
