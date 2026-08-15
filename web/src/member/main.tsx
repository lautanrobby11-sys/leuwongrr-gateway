import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { motion } from 'motion/react';
import {
  api,
  ApiError,
  type BillingSummary,
  type LedgerEntry,
  type Plan
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
  ToastHost,
  cx,
  inputClass,
  useToast,
  type NavItem
} from '../components/ui';
import { dateTime, daysUntil, money, shortDate, tokens } from '../lib/format';
import '../styles.css';

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

function Member() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [account, setAccount] = useState<{ email: string; display_name: string } | null>(null);
  const [days, setDays] = useState<Array<{ day: string; units: number }>>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [keys, setKeys] = useState<Array<{ id: string; name: string; prefix: string; last4: string; scopes: string[]; createdAt: string; revokedAt: string | null }>>([]);
  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null);
  const [payments, setPayments] = useState<Array<Record<string, string | number | null>>>([]);
  const [keyModal, setKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['models:read', 'chat:write']);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [topupAmount, setTopupAmount] = useState(10);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [overview, usage, planList, keyList, paymentList] = await Promise.all([api.member.overview(), api.member.usage(), api.member.plans(), api.member.keys(), api.member.payments()]);
      setBilling(overview.billing); setLedger(overview.ledger); setAccount(overview.account); setDays(usage.days); setPlans(planList.plans); setKeys(keyList.keys); setPayments(paymentList.payments);
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

  async function subscribe(plan: Plan) {
    setBusy(true);
    try { const result = await api.member.subscribe(plan.id); if (result.payment_url) { window.location.href = result.payment_url; return; } toast(`${plan.name} activated`); await load(); }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Could not start the plan', 'bad'); }
    finally { setBusy(false); }
  }

  async function topup(plan: Plan) {
    setBusy(true);
    try { const result = await api.member.topup(plan.id, Math.round(topupAmount * 100)); window.location.href = result.payment_url; }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Could not open the invoice', 'bad'); setBusy(false); }
  }

  const paygPlan = plans.find((plan) => plan.overageCentsPerMillion > 0) ?? plans[0] ?? null;
  return (
    <Shell title="LeuwongRR" subtitle={account?.email} items={NAV} active={tab} onSelect={setTab} onSignOut={() => void api.logout().then(() => (window.location.href = '/login'))}>
      {loading || !billing ? <Spinner label="Loading your account" /> : <>
        {tab === 'overview' && <div className="space-y-4">
          {!billing.funded && <div className="animate-rise flex flex-wrap items-center justify-between gap-3 rounded-card border border-bad/40 bg-bad/5 px-4 py-3"><p className="flex items-center gap-2 text-sm"><Icon name="alert" size={16} className="text-bad" />Your balance is empty. API requests are being refused.</p><Button icon="wallet" onClick={() => setTab('plans')}>Add tokens</Button></div>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="Available" value={tokens(billing.totalAvailable)} hint="Plan allowance plus wallet" icon="wallet" tone={billing.funded ? 'good' : 'bad'} /><Stat label="Used today" value={tokens(billing.usageToday)} icon="activity" /><Stat label="This period" value={tokens(billing.usageThisPeriod)} icon="trend" /><Stat label="Runway" value={billing.projectedDaysLeft === null ? '—' : `${billing.projectedDaysLeft}d`} hint="At today's burn rate" icon="gauge" tone={billing.projectedDaysLeft !== null && billing.projectedDaysLeft <= 3 ? 'warn' : 'default'} /></div>
          <TokenFlow billing={billing} />
          <Card title="Recent ledger" subtitle="Every grant, purchase, and debit"><Table headers={['When', 'Type', 'Source', 'Tokens', 'Balance']} empty={ledger.length === 0}>{ledger.map((entry) => <tr key={entry.id}><Cell className="whitespace-nowrap text-muted">{dateTime(entry.createdAt)}</Cell><Cell><Badge tone={entry.tokens >= 0 ? 'good' : 'neutral'}>{entry.kind}</Badge></Cell><Cell className="text-muted">{entry.source}</Cell><Cell className={cx('tabular-nums font-medium', entry.tokens >= 0 ? 'text-good' : 'text-ink')}>{entry.tokens >= 0 ? '+' : ''}{tokens(entry.tokens)}</Cell><Cell className="tabular-nums text-muted">{tokens(entry.balanceAfter)}</Cell></tr>)}</Table></Card>
        </div>}
        {tab === 'usage' && <div className="space-y-4"><Card title="Daily usage" subtitle="Settled units, last 30 days"><UsageChart days={days} /></Card><Card title="Payments" subtitle="Invoices raised through Cryptomus"><Table headers={['Order', 'Purpose', 'Tokens', 'Amount', 'Status', 'Created']} empty={payments.length === 0}>{payments.map((payment) => <tr key={String(payment.order_id)}><Cell className="font-mono text-xs text-muted">{String(payment.order_id).slice(0, 18)}</Cell><Cell>{String(payment.purpose)}</Cell><Cell className="tabular-nums">{tokens(Number(payment.tokens ?? 0))}</Cell><Cell className="tabular-nums">{money(Number(payment.amount_cents ?? 0))}</Cell><Cell><Badge tone={String(payment.status).startsWith('paid') ? 'good' : String(payment.status) === 'cancel' ? 'bad' : 'warn'}>{String(payment.status)}</Badge></Cell><Cell className="whitespace-nowrap text-muted">{dateTime(String(payment.created_at))}</Cell></tr>)}</Table></Card></div>}
        {tab === 'plans' && <div className="space-y-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{plans.map((plan) => { const current = billing.subscription?.planId === plan.id; return <Card key={plan.id} title={plan.name} subtitle={`${tokens(plan.includedTokens)} tokens each month`} action={current ? <Badge tone="brand">Current</Badge> : null}><p className="text-2xl font-semibold tabular-nums">{money(plan.monthlyPriceCents)}<span className="text-sm font-normal text-muted">/mo</span></p><ul className="mt-3 space-y-1.5 text-xs text-muted"><li>{money(plan.overageCentsPerMillion)} per million extra tokens</li><li>{plan.rateLimitRpm} requests per minute</li><li>{plan.maxConcurrent} concurrent requests</li><li>{plan.models.length} models included</li></ul><Button className="mt-4 w-full" variant={current ? 'outline' : 'primary'} icon="card" busy={busy} disabled={current} onClick={() => void subscribe(plan)}>{current ? 'Active' : plan.monthlyPriceCents === 0 ? 'Activate' : 'Subscribe'}</Button></Card>; })}</div>
          {paygPlan && <Card title="Pay as you go" subtitle="Buy tokens outright. They never expire and are spent after your plan allowance."><div className="flex flex-wrap items-end gap-3"><Field label="Amount (USD)"><input className={`${inputClass} w-32`} type="number" min={1} max={10000} value={topupAmount} onChange={(event) => setTopupAmount(Number(event.target.value))} /></Field><p className="pb-2 text-sm text-muted">≈ <span className="font-medium text-ink tabular-nums">{tokens(Math.floor((topupAmount * 100 / Math.max(1, paygPlan.overageCentsPerMillion)) * 1_000_000))}</span> tokens</p><Button icon="wallet" busy={busy} onClick={() => void topup(paygPlan)}>Pay with crypto</Button></div></Card>}
        </div>}
        {tab === 'keys' && <Card title="API keys" subtitle="Use these with the OpenAI or Anthropic SDKs" action={<Button icon="plus" onClick={() => setKeyModal(true)}>New key</Button>}><Table headers={['Name', 'Key', 'Scopes', 'Created', 'Status', '']} empty={keys.length === 0}>{keys.map((key) => <tr key={key.id}><Cell className="font-medium">{key.name}</Cell><Cell className="font-mono text-xs text-muted"><div className="flex items-center gap-1.5">{revealedKeyId === key.id ? <span className="text-ink">{key.prefix}{'…'}{key.last4}</span> : <span>{key.prefix}{'••••'}{key.last4}</span>}<button type="button" className="cursor-pointer rounded-md p-0.5 text-muted transition-colors hover:text-ink" aria-label={revealedKeyId === key.id ? 'Hide key' : 'Reveal key'} onClick={() => setRevealedKeyId((current) => (current === key.id ? null : key.id))}><Icon name={revealedKeyId === key.id ? 'eyeOff' : 'eye'} size={15} /></button></div></Cell><Cell className="text-xs text-muted">{key.scopes.join(', ')}</Cell><Cell className="whitespace-nowrap text-muted">{shortDate(key.createdAt)}</Cell><Cell><Badge tone={key.revokedAt ? 'bad' : 'good'}>{key.revokedAt ? 'Revoked' : 'Active'}</Badge></Cell><Cell className="text-right">{!key.revokedAt && <Button variant="danger" onClick={() => void api.member.revokeKey(key.id).then(load).then(() => toast('Key revoked'))}>Revoke</Button>}</Cell></tr>)}</Table></Card>}
        <Modal open={keyModal} title={issuedKey ? 'Copy your key' : 'Create an API key'} onClose={() => { setKeyModal(false); setIssuedKey(null); }}>{issuedKey ? <div className="space-y-3"><p className="text-sm text-muted">This is the only time the key is shown. The gateway stores a hash, so it cannot be recovered later.</p><code className="block break-all rounded-lg border border-border bg-raised p-3 font-mono text-xs">{issuedKey}</code><Button icon="check" className="w-full" onClick={() => { void navigator.clipboard.writeText(issuedKey); toast('Key copied'); }}>Copy to clipboard</Button></div> : <div className="space-y-4"><Field label="Name" hint="Something you will recognise later, like 'codex-laptop'"><input className={inputClass} value={keyName} onChange={(event) => setKeyName(event.target.value)} /></Field><Field label="Scopes"><div className="grid gap-2 sm:grid-cols-2">{['models:read', 'chat:write', 'responses:write', 'messages:write'].map((scope) => <label key={scope} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2 text-sm"><input type="checkbox" className="accent-brand" checked={keyScopes.includes(scope)} onChange={(event) => setKeyScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} /><span className="font-mono text-xs">{scope}</span></label>)}</div></Field><Button className="w-full" icon="key" busy={busy} disabled={keyName.trim().length === 0 || keyScopes.length === 0} onClick={() => void createKey()}>Create key</Button></div>}</Modal>
      </>}
    </Shell>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><ToastHost><Member /></ToastHost></StrictMode>);
