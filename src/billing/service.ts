import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

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
  active: boolean;
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
  active: number;
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
    active: row.active === 1
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
    autoRenew: row.auto_renew === 1
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

  getPlan(planId: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as
      | PlanRow
      | undefined;
    return row ? toPlan(row) : null;
  }

  upsertPlan(plan: Omit<Plan, 'active'> & { active?: boolean }): Plan {
    this.db
      .prepare(
        `INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at)
         VALUES (@id, @name, @price, @included, @overage, @concurrent, @rpm, @daily, @models, @active, @updated)
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

  /**
   * Starting a period grants the allowance as a ledger entry, so the dashboard
   * can always explain where a token balance came from.
   */
  startSubscription(accountId: string, planId: string, periodDays = 30): Subscription {
    const plan = this.getPlan(planId);
    if (!plan) throw new BillingError('plan_not_found', 404);
    if (!plan.active) throw new BillingError('plan_inactive', 409);

    const id = randomUUID();
    const start = this.iso();
    const end = this.iso(periodDays * 24 * 3_600_000);
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE account_id = ? AND status IN ('active','past_due')"
        )
        .run(start, accountId);
      this.db
        .prepare(
          `INSERT INTO subscriptions (id, account_id, plan_id, status, period_start, period_end, included_tokens, used_tokens, auto_renew, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 1, ?, ?)`
        )
        .run(id, accountId, planId, start, end, plan.includedTokens, start, start);
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
    const created = this.activeSubscription(accountId);
    if (!created) throw new BillingError('subscription_write_failed', 500);
    return created;
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

  private recordLedger(
    accountId: string,
    entry: {
      kind: LedgerEntry['kind'];
      source: LedgerEntry['source'];
      tokens: number;
      reference: string;
      balanceAfter: number;
    }
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ledger_entries (id, account_id, kind, source, tokens, reference, balance_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        accountId,
        entry.kind,
        entry.source,
        entry.tokens,
        entry.reference,
        entry.balanceAfter,
        this.iso()
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

  ledger(accountId: string, limit = 50): LedgerEntry[] {
    const rows = this.db
      .prepare(
        'SELECT id, kind, source, tokens, reference, balance_after, created_at FROM ledger_entries WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(accountId, limit) as Array<{
      id: string;
      kind: string;
      source: string;
      tokens: number;
      reference: string;
      balance_after: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      source: row.source,
      tokens: row.tokens,
      reference: row.reference,
      balanceAfter: row.balance_after,
      createdAt: row.created_at
    }));
  }

  // ---- Metering ----

  /**
   * Spend order is subscription allowance first, then the prepaid wallet. A
   * shortfall is recorded and the subscription is marked past_due; it is never
   * rounded away, because that would hand out free capacity.
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
    const subscription = this.activeSubscription(accountId);
    if (subscription && subscription.status !== 'canceled') {
      const available = Math.max(0, subscription.includedTokens - subscription.usedTokens);
      const fromPlan = Math.min(available, remaining);
      if (fromPlan > 0) {
        this.db
          .prepare('UPDATE subscriptions SET used_tokens = used_tokens + ?, updated_at = ? WHERE id = ?')
          .run(fromPlan, this.iso(), subscription.id);
        remaining -= fromPlan;
      }
    }

    const wallet = this.walletBalance(accountId);
    const fromWallet = Math.min(wallet, remaining);
    const balanceAfter = wallet - fromWallet;
    if (fromWallet > 0) {
      this.db
        .prepare('UPDATE wallets SET balance_tokens = ?, updated_at = ? WHERE account_id = ?')
        .run(balanceAfter, this.iso(), accountId);
      remaining -= fromWallet;
    }

    this.recordLedger(accountId, {
      kind: 'debit',
      source: 'usage',
      tokens: -(units - remaining),
      reference,
      balanceAfter
    });

    if (remaining > 0) {
      this.recordLedger(accountId, {
        kind: 'adjustment',
        source: 'usage',
        tokens: -remaining,
        reference: reference + ':unfunded',
        balanceAfter
      });
      if (subscription) {
        this.db
          .prepare("UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?")
          .run(this.iso(), subscription.id);
      }
    }
  }

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
    return {
      plan,
      subscription,
      walletTokens,
      subscriptionRemaining,
      totalAvailable,
      funded: totalAvailable > 0,
      usageToday: today.total,
      usageThisPeriod: period.total,
      projectedDaysLeft: burnPerDay > 0 ? Math.floor(totalAvailable / burnPerDay) : null
    };
  }

  /** Cheap gate for the request path: reconcile, then refuse an empty account. */
  assertFunded(accountId: string, tenantId: string): void {
    this.reconcile(accountId, tenantId);
    const subscription = this.activeSubscription(accountId);
    const remaining = subscription
      ? Math.max(0, subscription.includedTokens - subscription.usedTokens)
      : 0;
    if (remaining + this.walletBalance(accountId) <= 0) {
      throw new BillingError('insufficient_tokens', 402);
    }
  }
}
