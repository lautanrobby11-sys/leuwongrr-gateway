import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motion } from 'motion/react';
import {
  api,
  ApiError,
  type BillingSummary,
  type LedgerEntry,
  type Plan,
  type SubscriptionInfo,
  type UsageRecent
} from '../lib/api';
import { Icon, type IconName } from '../components/icons';
import {
  Badge,
  Button,
  Card,
  Cell,
  EmptyState,
  Field,
  Meter,
  Modal,
  Shell,
  Spinner,
  Stat,
  Table,
  Tabs,
  ToastHost,
  cx,
  inputClass,
  useToast,
  type NavItem
} from '../components/ui';
import {
  cachePercent,
  dateTime,
  daysUntil,
  duration,
  money,
  moneyPrecise,
  shortDate,
  tokens,
  tokensPerSecond
} from '../lib/format';
import '../styles.css';

/**
 * Parses a token-quantity input that the operator types digit by digit. It
 * accepts partial states like "12." so a controlled numeric field never loses
 * what was just typed. Returns NaN for anything the engine cannot spend, which
 * keeps the purchase button disabled instead of silently buying zero.
 */
function parseTokenInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '0.') return Number.NaN;
  return Number(trimmed);
}

/**
 * Mirrors the server's pricing preview: the plan's pay-as-you-go rate plus a
 * 5% convenience markup, rounded up to whole cents. The actual charge is
 * computed on the server; this only drives the on-screen estimate.
 */
function customTokenPriceCents(overageCentsPerMillion: number, tokensQuantity: number): number {
  if (!Number.isFinite(overageCentsPerMillion) || overageCentsPerMillion <= 0) return Number.NaN;
  if (!Number.isSafeInteger(tokensQuantity) || tokensQuantity <= 0) return Number.NaN;
  return Math.ceil((tokensQuantity / 1_000_000) * overageCentsPerMillion * 1.05);
}

/** Human label for a pack shelf life. */
function hoursLabel(hours: number): string {
  if (hours === 24) return '1 day';
  if (hours % 24 === 0) {
    const days = hours / 24;
    if (days === 7) return '1 week';
    if (days === 30) return '1 month';
    return `${days} days`;
  }
  return `${hours} hours`;
}

/** The shelf lives sold alongside custom token quantities. */
export const PACK_DURATIONS: readonly { hours: number; label: string }[] = [
  { hours: 24, label: 'Daily · 24 h' },
  { hours: 24 * 7, label: 'Weekly · 7 days' },
  { hours: 24 * 30, label: 'Monthly · 30 days' }
];

/** Minimum custom token purchase, one whole million. */
const MIN_CUSTOM_TOKENS = 1_000_000;

const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'usage', label: 'Usage', icon: 'activity' },
  { id: 'plans', label: 'Plans', icon: 'card' },
  { id: 'keys', label: 'API keys', icon: 'key' }
];

interface FlowStep {
  icon: IconName;
  title: string;
  detail: string;
  value: string;
  tone: 'brand' | 'good' | 'warn' | 'bad' | 'neutral';
}

function TokenFlow({ billing }: { billing: BillingSummary }) {
  const subscriptionUsed = billing.subscription?.usedTokens ?? 0;
  const subscriptionTotal = billing.subscription?.includedTokens ?? 0;
  const steps: FlowStep[] = [
    { icon: 'send', title: '1. Request arrives', detail: 'Key authenticated, tenant limits applied', value: `${tokens(billing.usageToday)} today`, tone: 'neutral' },
    { icon: 'shield', title: '2. Plan allowance', detail: subscriptionTotal > 0 ? 'Spent first, resets each period' : 'No active plan', value: `${tokens(billing.subscriptionRemaining)} left`, tone: billing.subscriptionRemaining > 0 ? 'good' : 'warn' },
    { icon: 'wallet', title: '3. Pay as you go', detail: 'Prepaid wallet covers anything above the plan', value: `${tokens(billing.walletTokens)} left`, tone: billing.walletTokens > 0 ? 'brand' : 'warn' },
    { icon: billing.funded ? 'check' : 'alert', title: '4. Settlement', detail: billing.funded ? 'Usage is metered, then debited from the ledger' : 'Requests are refused with 402 until you top up', value: billing.funded ? 'Funded' : 'Blocked', tone: billing.funded ? 'good' : 'bad' }
  ];
  const toneRing = { brand: 'border-brand/50 text-brand', good: 'border-good/50 text-good', warn: 'border-warn/50 text-warn', bad: 'border-bad/50 text-bad', neutral: 'border-border text-muted' } as const;
  return (
    <Card title="How your tokens are spent" subtitle="Every request walks this path in order">
      <ol className="grid gap-3 md:grid-cols-4">
        {steps.map((step, index) => (
          <motion.li key={step.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="relative rounded-card border border-border bg-raised p-3.5">
            <div className={cx('inline-flex rounded-lg border p-1.5', toneRing[step.tone])}><Icon name={step.icon} size={15} /></div>
            <p className="mt-2 text-sm font-medium">{step.title}</p><p className="mt-0.5 text-xs leading-relaxed text-muted">{step.detail}</p><p className="mt-2 text-sm font-semibold tabular-nums">{step.value}</p>
            {index < steps.length - 1 && <span className="absolute -bottom-2.5 left-1/2 z-10 -translate-x-1/2 text-muted md:-right-2.5 md:bottom-auto md:left-auto md:top-1/2 md:-translate-y-1/2 md:translate-x-0"><Icon name="arrowUp" size={14} className="rotate-180 md:-rotate-90" /></span>}
          </motion.li>
        ))}
      </ol>
      {subscriptionTotal > 0 && <div className="mt-5 space-y-3"><Meter used={subscriptionUsed} total={subscriptionTotal} label={`Plan allowance · ${tokens(subscriptionUsed)} of ${tokens(subscriptionTotal)}`} />{billing.subscription && <p className="text-xs text-muted">Period ends {shortDate(billing.subscription.periodEnd)}{daysUntil(billing.subscription.periodEnd) !== null && ` · ${daysUntil(billing.subscription.periodEnd)} days remaining`}</p>}</div>}
    </Card>
  );
}

function UsageChart({ days }: { days: Array<{ day: string; units: number }> }) {
  const peak = useMemo(() => Math.max(1, ...days.map((entry) => entry.units)), [days]);
  if (days.length === 0) return <EmptyState message="No settled usage in the last 30 days." icon="activity" />;
  return <div className="flex h-40 items-end gap-1 overflow-x-auto" role="img" aria-label="Daily token usage">{days.map((entry) => <div key={entry.day} className="group flex min-w-[10px] flex-1 flex-col items-center gap-1"><motion.div className="w-full rounded-t bg-brand/70 group-hover:bg-brand" initial={{ height: 0 }} animate={{ height: `${Math.max(2, (entry.units / peak) * 100)}%` }} transition={{ duration: 0.4 }} title={`${entry.day}: ${tokens(entry.units)} units`} /><span className="hidden text-[10px] text-muted sm:block">{entry.day.slice(8)}</span></div>)}</div>;
}

/**
 * App labels are derived server-side from the user agent (see app-label.ts). The
 * portal only maps the known set to an icon and a friendly name; an unrecognised
 * label still renders its raw text so a new client is visible before the map
 * catches up.
 */
const APP_META: Record<string, { label: string; icon: IconName }> = {
  zcode: { label: 'ZCode', icon: 'terminal' },
  'claude-code': { label: 'Claude Code', icon: 'terminal' },
  'claude-cli': { label: 'Claude CLI', icon: 'terminal' },
  codex: { label: 'Codex', icon: 'terminal' },
  cursor: { label: 'Cursor', icon: 'zap' },
  'openai-python': { label: 'OpenAI SDK', icon: 'bot' },
  'openai-node': { label: 'OpenAI SDK', icon: 'bot' },
  anthropic: { label: 'Anthropic SDK', icon: 'bot' },
  browser: { label: 'Browser', icon: 'message' },
  curl: { label: 'curl', icon: 'terminal' },
  other: { label: 'API', icon: 'send' }
};

function AppLabel({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted">—</span>;
  const meta = APP_META[value];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon name={meta?.icon ?? 'send'} size={13} className="text-muted" />
      <span>{meta?.label ?? value}</span>
    </span>
  );
}

/**
 * The per-request token breakdown, kept in one cell so the wide table stays
 * legible: input with its cached share, then output with its thinking share.
 * A missing split renders a dash rather than a zero it cannot vouch for.
 */
function TokenBreakdown({ row }: { row: UsageRecent }) {
  const cache = cachePercent(row.cachedTokens, row.inputTokens);
  return (
    <div className="flex flex-col gap-0.5 text-xs tabular-nums leading-tight">
      <span className="flex items-center gap-1">
        <Icon name="arrowUp" size={11} className="rotate-180 text-muted" />
        {row.inputTokens === null ? '—' : tokens(row.inputTokens)}
        {row.cachedTokens !== null && row.cachedTokens > 0 && (
          <span className="text-muted">({tokens(row.cachedTokens)} cached{cache !== '—' ? ` · ${cache}` : ''})</span>
        )}
      </span>
      <span className="flex items-center gap-1">
        <Icon name="arrowUp" size={11} className="text-muted" />
        {row.outputTokens === null ? '—' : tokens(row.outputTokens)}
        {row.thinkingTokens !== null && row.thinkingTokens > 0 && (
          <span className="text-muted">({tokens(row.thinkingTokens)} thinking)</span>
        )}
      </span>
    </div>
  );
}

/**
 * The rich recent-request ledger the member spec asks for: when, model, the
 * token split with cache/thinking detail, throughput, estimated cost, the
 * detected client app, and the finish reason. It shares the sortable Table
 * primitive; sorting stays here so the component owns its own row order.
 */
export function RecentRequests({ rows }: { rows: UsageRecent[] }) {
  const [sort, setSort] = useState<{ index: number; dir: 'asc' | 'desc' }>({ index: 0, dir: 'desc' });
  const headers = ['When', 'Model', 'Tokens', 'Speed', 'Cost est.', 'App', 'Finish'];
  const sorted = useMemo(() => {
    const key = (row: UsageRecent): number | string => {
      switch (sort.index) {
        case 0: return row.at;
        case 1: return row.model ?? '';
        case 2: return row.units;
        case 3: return (row.outputTokens ?? 0) / Math.max(1, row.durationMs ?? 1);
        case 4: return row.costCentsEst ?? -1;
        default: return row.at;
      }
    };
    return [...rows].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort]);
  const onSort = (index: number) =>
    setSort((current) => (current.index === index ? { index, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { index, dir: 'desc' }));
  return (
    <Table headers={headers} empty={rows.length === 0} sort={sort} onSort={onSort} sticky>
      {sorted.map((row) => (
        <tr key={row.requestId}>
          <Cell className="whitespace-nowrap text-muted">{dateTime(row.at)}</Cell>
          <Cell className="font-mono text-xs">{row.model ?? <span className="text-muted">unknown</span>}</Cell>
          <Cell><TokenBreakdown row={row} /></Cell>
          <Cell className="whitespace-nowrap text-xs tabular-nums text-muted">{tokensPerSecond(row.outputTokens, row.durationMs)}<br />{duration(row.durationMs)}</Cell>
          <Cell className="tabular-nums">{row.costCentsEst === null ? <span className="text-muted">—</span> : moneyPrecise(row.costCentsEst)}</Cell>
          <Cell className="text-xs"><AppLabel value={row.appLabel} /></Cell>
          <Cell className="text-xs text-muted">{row.finishReason ?? '—'}</Cell>
        </tr>
      ))}
    </Table>
  );
}

/**
 * The Overview ledger: fewer columns than the Usage tab, tuned to answer "where
 * did my balance go" at a glance. Grants and purchases read green, debits keep
 * the ink colour, and the source column names the model or plan when the server
 * supplies it.
 */
function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  return (
    <Table headers={['When', 'Type', 'Source', 'Tokens', 'Balance']} empty={entries.length === 0}>
      {entries.map((entry) => (
        <tr key={entry.id}>
          <Cell className="whitespace-nowrap text-muted">{dateTime(entry.createdAt)}</Cell>
          <Cell><Badge tone={entry.tokens >= 0 ? 'good' : 'neutral'}>{entry.kind}</Badge></Cell>
          <Cell className="text-muted">{entry.source}</Cell>
          <Cell className={cx('tabular-nums font-medium', entry.tokens >= 0 ? 'text-good' : 'text-ink')}>{entry.tokens >= 0 ? '+' : ''}{tokens(entry.tokens)}</Cell>
          <Cell className="tabular-nums text-muted">{tokens(entry.balanceAfter)}</Cell>
        </tr>
      ))}
    </Table>
  );
}

function Member() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [account, setAccount] = useState<{ email: string; display_name: string } | null>(null);
  const [days, setDays] = useState<Array<{ day: string; units: number }>>([]);
  const [recent, setRecent] = useState<UsageRecent[]>([]);
  const [usageTab, setUsageTab] = useState('requests');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [keys, setKeys] = useState<Array<{ id: string; name: string; prefix: string; last4: string; scopes: string[]; createdAt: string; revokedAt: string | null }>>([]);
  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null);
  const [payments, setPayments] = useState<Array<Record<string, string | number | null>>>([]);
  const [keyModal, setKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['models:read', 'chat:write']);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Rotation reuses the "copy your key" modal: the plaintext replacement is
  // shown once, exactly like a freshly issued key. `rotateTarget` holds the key
  // awaiting confirmation so the grace window is explicit before it is retired.
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  // Release 2 custom token builder state: the operator picks a quantity (whole
  // millions, minimum one) and a shelf life (daily / weekly / monthly).
  const [packQuantity, setPackQuantity] = useState('1');
  const [packDuration, setPackDuration] = useState<number>(24);
  const [packPlanId, setPackPlanId] = useState<string | null>(null);
  // Every live subscription, including stacked token packs; the summary only
  // carries the newest one.
  const [subscriptions, setSubscriptions] = useState<SubscriptionInfo[]>([]);
  const [resettingId, setResettingId] = useState<string | null>(null);

  async function loadSubscriptions() {
    try {
      const list = await api.member.subscriptions();
      setSubscriptions(list.subscriptions);
    } catch {
      // The overview already surfaces the newest subscription; a list failure
      // merely hides the stacked-pack detail.
      setSubscriptions([]);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const [overview, usage, planList, keyList, paymentList] = await Promise.all([api.member.overview(), api.member.usage(), api.member.plans(), api.member.keys(), api.member.payments()]);
      setBilling(overview.billing); setLedger(overview.ledger); setAccount(overview.account); setDays(usage.days); setRecent(usage.recent); setPlans(planList.plans); setKeys(keyList.keys); setPayments(paymentList.payments);
      await loadSubscriptions();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { window.location.href = '/login'; return; }
      toast(error instanceof ApiError ? error.message : 'Could not load your account', 'bad');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function createKey() {
    setBusy(true);
    try { const result = await api.member.createKey(keyName, keyScopes); setIssuedKey(result.key); setKeyName(''); await load(); }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Could not create the key', 'bad'); }
    finally { setBusy(false); }
  }

  /**
   * Rotates a key in place: the server mints a replacement with the same name
   * and scopes and retires the old one after a 30-minute grace window. The
   * plaintext is surfaced in the same once-only modal as a new key, then the
   * list reloads so the retiring key shows its pending revocation.
   */
  async function rotateKey() {
    if (!rotateTarget) return;
    setBusy(true);
    try {
      const result = await api.member.rotateKey(rotateTarget.id);
      setKeyModal(true);
      setIssuedKey(result.key);
      setRotateTarget(null);
      toast(`Key rotated · old key retires in ${result.grace_minutes} min`);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not rotate the key', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function subscribe(plan: Plan) {
    setBusy(true);
    try { const result = await api.member.subscribe(plan.id); if (result.payment_url) { window.location.href = result.payment_url; return; } toast(`${plan.name} activated`); await load(); }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Could not start the plan', 'bad'); }
    finally { setBusy(false); }
  }

  /** Buy a custom token pack: quantity + shelf life, price = PAYG rate + 5%. */
  async function buyPack(plan: Plan) {
    const quantity = parseTokenInput(packQuantity);
    if (!Number.isFinite(quantity) || quantity < MIN_CUSTOM_TOKENS) return;
    setBusy(true);
    try {
      const result = await api.member.customTopup(plan.id, quantity, packDuration);
      window.location.href = result.payment_url;
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not open the invoice', 'bad');
      setBusy(false);
    }
  }

  /** Resets a running subscription timer, consuming one of its allowances. */
  async function resetTimer(subscriptionId: string) {
    setResettingId(subscriptionId);
    try {
      await api.member.resetSubscription(subscriptionId);
      toast('Timer reset');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not reset the timer', 'bad');
    } finally {
      setResettingId(null);
    }
  }

  const paygPlan = plans.find((plan) => plan.overageCentsPerMillion > 0) ?? plans[0] ?? null;
  // Plans are shown in two groups: rolling-time subscriptions (no token
  // allowance, billed for a window) and token packs (an allowance to spend).
  const rollingPlans = plans.filter((plan) => (plan.method ?? 'token_pack') === 'rolling_time');
  const packPlans = plans.filter((plan) => (plan.method ?? 'token_pack') !== 'rolling_time');

  // The plan the pack builder prices against: honour an explicit selection,
  // otherwise fall back to the one with a usable PAYG rate.
  const builderPlan =
    packPlans.find((plan) => plan.id === packPlanId) ?? paygPlan;
  const packQuantityNum = parseTokenInput(packQuantity);
  const packPrice = builderPlan
    ? customTokenPriceCents(builderPlan.overageCentsPerMillion, packQuantityNum)
    : Number.NaN;
  const packValid =
    !!builderPlan &&
    Number.isInteger(packQuantityNum) &&
    packQuantityNum >= MIN_CUSTOM_TOKENS &&
    packQuantityNum <= 1_000_000_000 &&
    Number.isFinite(packPrice) &&
    packPrice > 0;
  return (
    <Shell title="LeuwongRR" subtitle={account?.email} items={NAV} active={tab} onSelect={setTab} onSignOut={() => void api.logout().then(() => (window.location.href = '/login'))}>
      {loading || !billing ? <Spinner label="Loading your account" /> : <>
        {tab === 'overview' && <div className="space-y-4">
          {!billing.funded && <div className="animate-rise flex flex-wrap items-center justify-between gap-3 rounded-card border border-bad/40 bg-bad/5 px-4 py-3"><p className="flex items-center gap-2 text-sm"><Icon name="alert" size={16} className="text-bad" />Your balance is empty. API requests are being refused.</p><Button icon="wallet" onClick={() => setTab('plans')}>Add tokens</Button></div>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="Available" value={tokens(billing.totalAvailable)} hint="Plan allowance plus wallet" icon="wallet" tone={billing.funded ? 'good' : 'bad'} /><Stat label="Used today" value={tokens(billing.usageToday)} icon="activity" /><Stat label="This period" value={tokens(billing.usageThisPeriod)} icon="trend" /><Stat label="Runway" value={billing.projectedDaysLeft === null ? '—' : `${billing.projectedDaysLeft}d`} hint="At today's burn rate" icon="gauge" tone={billing.projectedDaysLeft !== null && billing.projectedDaysLeft <= 3 ? 'warn' : 'default'} /></div>
          <TokenFlow billing={billing} />
          <Card title="Recent ledger" subtitle="Every grant, purchase, and debit"><LedgerTable entries={ledger} /></Card>
        </div>}
        {tab === 'usage' && <div className="space-y-4">
          <Tabs
            tabs={[{ id: 'requests', label: 'Requests', icon: 'activity' }, { id: 'daily', label: 'Daily', icon: 'trend' }, { id: 'payments', label: 'Payments', icon: 'wallet' }]}
            active={usageTab}
            onChange={setUsageTab}
          />
          {usageTab === 'requests' && <Card title="Recent requests" subtitle="Last 50 settled requests · cost is an estimate against list price, the ledger rules the real balance"><RecentRequests rows={recent} /></Card>}
          {usageTab === 'daily' && <Card title="Daily usage" subtitle="Settled units, last 30 days"><UsageChart days={days} /></Card>}
          {usageTab === 'payments' && <Card title="Payments" subtitle="Invoices raised through Cryptomus"><Table headers={['Order', 'Purpose', 'Tokens', 'Amount', 'Status', 'Created']} empty={payments.length === 0}>{payments.map((payment) => <tr key={String(payment.order_id)}><Cell className="font-mono text-xs text-muted">{String(payment.order_id).slice(0, 18)}</Cell><Cell>{String(payment.purpose)}</Cell><Cell className="tabular-nums">{tokens(Number(payment.tokens ?? 0))}</Cell><Cell className="tabular-nums">{money(Number(payment.amount_cents ?? 0))}</Cell><Cell><Badge tone={String(payment.status).startsWith('paid') ? 'good' : String(payment.status) === 'cancel' ? 'bad' : 'warn'}>{String(payment.status)}</Badge></Cell><Cell className="whitespace-nowrap text-muted">{dateTime(String(payment.created_at))}</Cell></tr>)}</Table></Card>}
        </div>}
        {tab === 'plans' && <div className="space-y-4">
          <Card title="Your subscriptions" subtitle="Rolling time passes and every live token pack, each with its own countdown">
            <Table headers={['Plan', 'Kind', 'Allowance', 'Used', 'Expires', 'Resets', '']} empty={subscriptions.length === 0}>
              {subscriptions.map((sub) => {
                const method = sub.method ?? 'token_pack';
                const kind = method === 'rolling_time' ? 'Rolling time' : method === 'monetary_pack' ? 'Pack' : 'Token pack';
                const label = sub.expiresAt ? (Number.isInteger(sub.durationHours) && sub.durationHours !== null && sub.durationHours <= 72 ? hoursLabel(sub.durationHours ?? 0) : shortDate(sub.expiresAt)) : (sub.timerBasis === 'from_first_use' && !sub.activatedAt ? 'Starts on first use' : '—');
                return <tr key={sub.id}>
                  <Cell><span className="font-medium">{sub.planName}</span>{sub.tierLabel ? <span className="ml-1.5 text-xs text-muted">{sub.tierLabel}</span> : null}</Cell>
                  <Cell><Badge tone={method === 'rolling_time' ? 'brand' : 'good'}>{kind}</Badge></Cell>
                  <Cell className="tabular-nums">{tokens(sub.includedTokens)}</Cell>
                  <Cell className="tabular-nums">{tokens(sub.usedTokens)}</Cell>
                  <Cell className="text-muted">{label}</Cell>
                  <Cell className="tabular-nums">{sub.resetsRemaining}</Cell>
                  <Cell className="text-right">{sub.resetsRemaining > 0 && <Button variant="outline" busy={resettingId === sub.id} disabled={resettingId !== null} onClick={() => void resetTimer(sub.id)}>Reset timer</Button>}</Cell>
                </tr>;
              })}
            </Table>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold">Rolling time plans</h2>
              <div className="grid gap-3">{rollingPlans.map((plan) => { const current = billing.subscription?.planId === plan.id; const price = plan.priceCents ?? plan.monthlyPriceCents; return <Card key={plan.id} title={plan.name} subtitle={plan.durationHours ? `Rolling window · ${hoursLabel(plan.durationHours)}` : 'Rolling window'} action={current ? <Badge tone="brand">Current</Badge> : null}><p className="text-2xl font-semibold tabular-nums">{money(price)}</p><ul className="mt-3 space-y-1.5 text-xs text-muted"><li>{plan.rateLimitRpm} requests per minute</li><li>{plan.maxConcurrent} concurrent requests</li><li>{plan.models.length} models included</li><li>{plan.resetsAllowed ?? 0} timer resets included</li></ul><Button className="mt-4 w-full" variant={current ? 'outline' : 'primary'} icon="card" busy={busy} disabled={current} onClick={() => void subscribe(plan)}>{current ? 'Active' : price === 0 ? 'Activate' : 'Subscribe'}</Button></Card>; })}
              {rollingPlans.length === 0 && <EmptyState message="No rolling time plans are offered right now." icon="card" />}
              </div>
            </div>
            <div>
              <h2 className="mb-2 text-sm font-semibold">Token packs</h2>
              <div className="grid gap-3">{packPlans.map((plan) => { const current = billing.subscription?.planId === plan.id; const price = plan.priceCents ?? plan.monthlyPriceCents; const sub = subscriptions.find((row) => row.planId === plan.id); return <Card key={plan.id} title={plan.name} subtitle={plan.durationHours ? `${tokens(plan.includedTokens)} tokens · ${hoursLabel(plan.durationHours)} shelf life` : `${tokens(plan.includedTokens)} tokens`} action={sub ? <Badge tone="brand">Owned</Badge> : current ? <Badge tone="brand">Current</Badge> : null}><p className="text-2xl font-semibold tabular-nums">{money(price)}</p><ul className="mt-3 space-y-1.5 text-xs text-muted"><li>{money(plan.overageCentsPerMillion)} per million extra tokens</li><li>{plan.rateLimitRpm} requests per minute</li><li>{plan.maxConcurrent} concurrent requests</li><li>{plan.models.length} models included</li><li>Packs accumulate — each keeps its own countdown</li></ul><Button className="mt-4 w-full" variant={current ? 'outline' : 'primary'} icon="card" busy={busy} disabled={current} onClick={() => void subscribe(plan)}>{current ? 'Active' : price === 0 ? 'Top up' : 'Buy tokens'}</Button></Card>; })}
              {packPlans.length === 0 && <EmptyState message="No token packs are offered right now." icon="card" />}
              </div>
            </div>
          </div>
          {builderPlan && <Card title="Custom token pack" subtitle="Buy any quantity at the plan's token rate plus 5%. Packs stack and each expires on its own clock.">
            <div className="grid gap-4 md:grid-cols-[1fr_auto_auto_auto]">
              <div className="min-w-0 md:col-span-2">
                <Field label="Plan rate" hint="+5% convenience fee applies to every pack">
                  <select className={inputClass} value={builderPlan.id} onChange={(event) => setPackPlanId(event.target.value)}>
                    {packPlans.filter((plan) => plan.overageCentsPerMillion > 0).map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {money(plan.overageCentsPerMillion)}/M tokens</option>)}
                  </select>
                </Field>
                <Field label="Token quantity" hint="Whole millions only, minimum 1,000,000" className="mt-3">
                  <input className={`${inputClass} tabular-nums`} type="text" inputMode="numeric" placeholder="1000000" value={packQuantity} onChange={(event) => setPackQuantity(event.target.value.replace(/[^0-9.]/g, ''))} />
                </Field>
              </div>
              <Field label="Shelf life" className="min-w-40">
                <select className={inputClass} value={String(packDuration)} onChange={(event) => setPackDuration(Number(event.target.value))}>
                  {PACK_DURATIONS.map((option) => <option key={option.hours} value={String(option.hours)}>{option.label}</option>)}
                </select>
              </Field>
              <div className="flex flex-col items-stretch justify-end gap-1.5">
                <p className="text-xs text-muted">Total</p>
                <p className="text-xl font-semibold tabular-nums">{Number.isFinite(packPrice) ? money(Math.ceil(packPrice)) : '—'}</p>
                <Button icon="wallet" busy={busy} disabled={!packValid} onClick={() => void buyPack(builderPlan)}>Pay {Number.isFinite(packPrice) ? money(Math.ceil(packPrice)) : ''}</Button>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted">Tokens are spent before the wallet, oldest-expiry first. A 1M minimum keeps custom pricing honest; every pack gets its own countdown from the moment it settles.</p>
          </Card>}
        </div>}
        {tab === 'keys' && <Card title="API keys" subtitle="Use these with the OpenAI or Anthropic SDKs" action={<Button icon="plus" onClick={() => setKeyModal(true)}>New key</Button>}><Table headers={['Name', 'Key', 'Scopes', 'Created', 'Status', '']} empty={keys.length === 0}>{keys.map((key) => <tr key={key.id}><Cell className="font-medium">{key.name}</Cell><Cell className="font-mono text-xs text-muted"><div className="flex items-center gap-1.5">{revealedKeyId === key.id ? <span className="text-ink">{key.prefix}{'…'}{key.last4}</span> : <span>{key.prefix}{'••••'}{key.last4}</span>}<button type="button" className="cursor-pointer rounded-md p-0.5 text-muted transition-colors hover:text-ink" aria-label={revealedKeyId === key.id ? 'Hide key' : 'Reveal key'} onClick={() => setRevealedKeyId((current) => (current === key.id ? null : key.id))}><Icon name={revealedKeyId === key.id ? 'eyeOff' : 'eye'} size={15} /></button></div></Cell><Cell className="text-xs text-muted">{key.scopes.join(', ')}</Cell><Cell className="whitespace-nowrap text-muted">{shortDate(key.createdAt)}</Cell><Cell><Badge tone={key.revokedAt ? 'bad' : 'good'}>{key.revokedAt ? 'Revoked' : 'Active'}</Badge></Cell><Cell className="text-right">{!key.revokedAt && <div className="flex justify-end gap-1.5"><Button variant="outline" icon="key" onClick={() => setRotateTarget({ id: key.id, name: key.name })}>Rotate</Button><Button variant="danger" onClick={() => void api.member.revokeKey(key.id).then(load).then(() => toast('Key revoked'))}>Revoke</Button></div>}</Cell></tr>)}</Table></Card>}
        <Modal open={keyModal} title={issuedKey ? 'Copy your key' : 'Create an API key'} onClose={() => { setKeyModal(false); setIssuedKey(null); }}>{issuedKey ? <div className="space-y-3"><p className="text-sm text-muted">This is the only time the key is shown. The gateway stores a hash, so it cannot be recovered later.</p><code className="block break-all rounded-lg border border-border bg-raised p-3 font-mono text-xs">{issuedKey}</code><Button icon="check" className="w-full" onClick={() => { void navigator.clipboard.writeText(issuedKey); toast('Key copied'); }}>Copy to clipboard</Button></div> : <div className="space-y-4"><Field label="Name" hint="Something you will recognise later, like 'codex-laptop'"><input className={inputClass} value={keyName} onChange={(event) => setKeyName(event.target.value)} /></Field><Field label="Scopes"><div className="grid gap-2 sm:grid-cols-2">{['models:read', 'chat:write', 'responses:write', 'messages:write'].map((scope) => <label key={scope} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2 text-sm"><input type="checkbox" className="accent-brand" checked={keyScopes.includes(scope)} onChange={(event) => setKeyScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} /><span className="font-mono text-xs">{scope}</span></label>)}</div></Field><Button className="w-full" icon="key" busy={busy} disabled={keyName.trim().length === 0 || keyScopes.length === 0} onClick={() => void createKey()}>Create key</Button></div>}</Modal>
        <Modal open={rotateTarget !== null} title="Rotate API key" onClose={() => setRotateTarget(null)}>
          <div className="space-y-4">
            <p className="text-sm text-muted">Rotating <span className="font-medium text-ink">{rotateTarget?.name}</span> mints a fresh key with the same scopes and shows it once. The current key keeps working for a 30-minute grace window so live callers can switch over without an outage, then it is revoked automatically.</p>
            <div className="flex items-start gap-2 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2.5 text-xs text-muted"><Icon name="shield" size={15} className="mt-0.5 shrink-0 text-brand" />Rotate instead of creating new keys — it keeps the key count flat and avoids hitting the daily key limit.</div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setRotateTarget(null)}>Cancel</Button><Button icon="key" busy={busy} onClick={() => void rotateKey()}>Rotate key</Button></div>
          </div>
        </Modal>
      </>}
    </Shell>
  );
}

// Guard the mount so importing this module has no side effect off the page:
// the DOM behavioural tests import components directly and there is no #root
// then, while member.html always provides one in the browser.
const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<StrictMode><ToastHost><Member /></ToastHost></StrictMode>);
}