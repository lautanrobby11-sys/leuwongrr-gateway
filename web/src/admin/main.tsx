import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  api,
  ApiError,
  type BillingSummary,
  type EffectiveTenantLimits,
  type ModelInput,
  type Plan,
  type TenantLimits
} from '../lib/api';
import { Icon } from '../components/icons';
import { applyStoredTheme } from '../components/theme';
import {
  Badge,
  Button,
  Card,
  Cell,
  Field,
  Modal,
  PriceInput,
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
import { dateTime, money, tokens } from '../lib/format';
import { parseBulkModels } from './bulk-models';
import {
  formatLimitInput,
  limitsSaveDisabled,
  parseLimitInput,
  DAILY_BUDGET_UNITS,
  MAX_CONCURRENT,
  RATE_LIMIT_RPM
} from './limits-validation';
import '../styles.css';

const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'plans', label: 'Plans', icon: 'card' },
  { id: 'models', label: 'Models', icon: 'bot' },
  { id: 'accounts', label: 'Accounts', icon: 'users' },
  { id: 'payments', label: 'Payments', icon: 'wallet' }
];

interface AdminAccount {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  tenantId: string;
  billing: BillingSummary;
  /** The enforced envelope from `tenant_limits`, or the process defaults. */
  limits: EffectiveTenantLimits;
}

/**
 * Bounds mirror the schema behind POST /console/api/admin/accounts/limits, so
 * the form cannot submit a value the gateway will reject with a 400.
 */
const BLANK_LIMITS: TenantLimits = { dailyBudgetUnits: 100_000, maxConcurrent: 2, rateLimitRpm: 120 };

function PlanEditor({
  plan,
  groups,
  onChange
}: {
  plan: Plan;
  groups: Array<{ id: string; name: string; enabled: boolean }>;
  onChange: (plan: Plan) => void;
}) {
  const numeric = (key: keyof Plan) => ({
    className: inputClass,
    type: 'number',
    value: String(plan[key] as number),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...plan, [key]: Number(event.target.value) })
  });

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Plan id" hint="Lowercase, used in the API">
        <input
          className={inputClass}
          value={plan.id}
          onChange={(event) => onChange({ ...plan, id: event.target.value })}
          placeholder="starter"
        />
      </Field>
      <Field label="Display name">
        <input
          className={inputClass}
          value={plan.name}
          onChange={(event) => onChange({ ...plan, name: event.target.value })}
          placeholder="Starter"
        />
      </Field>
      <Field label="Monthly price (cents)">
        <PriceInput
          label="Monthly price (cents)"
          value={plan.monthlyPriceCents}
          onChange={(value) => onChange({ ...plan, monthlyPriceCents: value })}
          placeholder="0.002"
        />
      </Field>
      <Field label="Included tokens">
        <input {...numeric('includedTokens')} />
      </Field>
      <Field label="Pay as you go (cents per million)" hint="Also sets the top-up exchange rate">
        <PriceInput
          label="Pay as you go (cents per million)"
          value={plan.overageCentsPerMillion}
          onChange={(value) => onChange({ ...plan, overageCentsPerMillion: value })}
          placeholder="0.002"
        />
      </Field>
      <Field label="Daily budget units">
        <input {...numeric('dailyBudgetUnits')} />
      </Field>
      <Field label="Rate limit (rpm)">
        <input {...numeric('rateLimitRpm')} />
      </Field>
      <Field label="Max concurrent">
        <input {...numeric('maxConcurrent')} />
      </Field>
      <div className="sm:col-span-2">
        <Field
          label="Model group"
          hint="Subscribers to this plan are entitled to every model in the group"
        >
          <select
            className={inputClass}
            value={plan.modelGroupId ?? ''}
            onChange={(event) => onChange({ ...plan, modelGroupId: event.target.value })}
          >
            <option value="">— no group —</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="space-y-3 rounded-lg border border-border/70 p-3 sm:col-span-2">
        <p className="text-xs font-medium text-muted">
          Subscription side — pick how time and tokens are sold to a member
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan method" hint="Rolling time sells a window; token packs sell an allowance">
            <select
              className={inputClass}
              value={plan.method ?? 'token_pack'}
              onChange={(event) => onChange({ ...plan, method: event.target.value as Plan['method'] })}
            >
              <option value="rolling_time">rolling_time — time window</option>
              <option value="token_pack">token_pack — token allowance</option>
              <option value="monetary_pack">monetary_pack — cents credit</option>
              <option value="payg">payg — metered</option>
            </select>
          </Field>
          <Field label="Tier label" hint="Shown in the member console, e.g. 'Starter'">
            <input
              className={inputClass}
              value={plan.tierLabel ?? ''}
              onChange={(event) => onChange({ ...plan, tierLabel: event.target.value })}
              placeholder="Starter"
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Purchase price (cents)" hint="Charged per purchase when the plan has a duration; 0 subscribes instantly">
            <PriceInput
              label="Purchase price in cents"
              value={plan.priceCents ?? 0}
              onChange={(value) => onChange({ ...plan, priceCents: value })}
              placeholder="0"
            />
          </Field>
          <Field label="Duration (hours)" hint="Rolling window or pack shelf life; blank sells indefinitely">
            <input
              className={inputClass}
              type="number"
              min={1}
              max={8760}
              value={plan.durationHours ?? ''}
              onChange={(event) =>
                onChange({
                  ...plan,
                  durationHours: event.target.value === '' ? null : Number(event.target.value)
                })
              }
            />
            <div className="mt-1.5 flex gap-1.5">
              {[24, 168, 720].map((hours) => (
                <button
                  key={hours}
                  type="button"
                  className="rounded-md border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:text-ink"
                  onClick={() => onChange({ ...plan, durationHours: hours })}
                >
                  {hours === 24 ? '24h' : hours === 168 ? '7d' : '30d'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Timer resets allowed" hint="How often a member may restart the window">
            <input
              className={inputClass}
              type="number"
              min={0}
              max={52}
              value={plan.resetsAllowed ?? 0}
              onChange={(event) => onChange({ ...plan, resetsAllowed: Number(event.target.value) })}
            />
          </Field>
        </div>
        <Field label="Timer basis" hint="When the window's countdown starts">
          <select
            className={inputClass}
            value={plan.timerBasis ?? 'from_payment'}
            onChange={(event) => onChange({ ...plan, timerBasis: event.target.value as Plan['timerBasis'] })}
          >
            <option value="from_payment">from payment</option>
            <option value="from_first_use">from first use</option>
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="accent-brand"
          checked={plan.active}
          onChange={(event) => onChange({ ...plan, active: event.target.checked })}
        />
        Offered to members
      </label>
    </div>
  );
}

const BLANK_PLAN: Plan = {
  id: '',
  name: '',
  monthlyPriceCents: 0,
  includedTokens: 0,
  overageCentsPerMillion: 200,
  maxConcurrent: 2,
  rateLimitRpm: 120,
  dailyBudgetUnits: 100_000,
  models: [],
  modelGroupId: 'legacy-default',
  active: true
};

/**
 * While a decimal is being typed, a price field briefly holds NaN, so Save must
 * stay disabled: submitting in that state would ship a non-number the route
 * answers with a 400, and the button would read as usable while the payload is
 * not. The predecimal form only ever needed the id/name check because the
 * number inputs could not go fractional.
 */
function planSaveDisabled(plan: Plan): boolean {
  const values = [
    plan.monthlyPriceCents,
    plan.includedTokens,
    plan.overageCentsPerMillion,
    plan.maxConcurrent,
    plan.rateLimitRpm,
    plan.dailyBudgetUnits,
    plan.priceCents ?? 0,
    plan.resetsAllowed ?? 0
  ];
  return (
    plan.id.trim().length === 0 ||
    plan.name.trim().length === 0 ||
    values.some((value) => !Number.isFinite(value)) ||
    (plan.durationHours !== null && plan.durationHours !== undefined && !Number.isFinite(plan.durationHours))
  );
}

function modelSaveDisabled(model: ModelInput): boolean {
  return (
    model.id.trim().length === 0 ||
    model.name.trim().length === 0 ||
    [model.inputPriceCents, model.outputPriceCents, model.cacheReadPriceCents].some(
      (value) => !Number.isFinite(value)
    )
  );
}

const BLANK_MODEL: ModelInput = {
  id: '',
  name: '',
  provider: 'openai',
  inputPriceCents: 0,
  outputPriceCents: 0,
  cacheReadPriceCents: 0,
  multimodalSupport: false,
  upstreamModel: '',
  enabled: false,
  groupId: 'legacy-default'
};

const MODEL_PAGE_SIZE = 10;

const BULK_PLACEHOLDER = [
  '# id, input ₵/M, output ₵/M, cache read ₵/M, enabled, group, upstream',
  '# use - to leave a field unchanged',
  'gpt-5, 125, 1000, 12.5, true, value, gpt-5',
  'claude-opus, 1500, 7500, -, true, premium, -',
  'legacy-model, -, -, -, false'
].join('\n');

/**
 * Bulk model editor: a paste target plus the parsed preview.
 *
 * Repricing 600+ synced models one modal at a time is the actual operator
 * problem, so the input is text an operator can produce from a spreadsheet or
 * the vendor's price page. The preview is the contract: it shows exactly which
 * models change and which lines were rejected, and Apply stays disabled while
 * there is nothing valid to send — the payload is never a guess at what the
 * text meant.
 */
export function BulkModelsEditor({
  text,
  onChange,
  onApply,
  busy
}: {
  text: string;
  onChange: (value: string) => void;
  onApply: (rows: ReturnType<typeof parseBulkModels>['rows']) => void;
  busy: boolean;
}) {
  const { rows, issues } = parseBulkModels(text);
  return (
    <div className="space-y-4">
      <Field
        label="Model lines"
        hint="One model per line: id, input, output, cache read, enabled, group, upstream. Comma or pipe separated; - keeps a field unchanged; # comments a line."
      >
        <textarea
          className={cx(inputClass, 'min-h-[180px] font-mono text-xs leading-relaxed')}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          placeholder={BULK_PLACEHOLDER}
          aria-label="Model lines"
          spellCheck={false}
        />
      </Field>

      {issues.length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/5 p-3">
          <p className="text-xs font-medium text-warn">
            {issues.length} line{issues.length === 1 ? '' : 's'} skipped
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
            {issues.slice(0, 8).map((issue) => (
              <li key={`${issue.line}:${issue.reason}`}>
                Line {issue.line}: {issue.reason}
              </li>
            ))}
            {issues.length > 8 && <li>…and {issues.length - 8} more</li>}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <Table headers={['Model', 'In ₵/M', 'Out ₵/M', 'Cache ₵/M', 'State', 'Group', 'Upstream']}>
          {rows.map((row) => (
            <tr key={row.id}>
              <Cell className="font-mono text-xs">{row.id}</Cell>
              <Cell className="tabular-nums">{row.inputPriceCents ?? '—'}</Cell>
              <Cell className="tabular-nums">{row.outputPriceCents ?? '—'}</Cell>
              <Cell className="tabular-nums">{row.cacheReadPriceCents ?? '—'}</Cell>
              <Cell className="text-xs text-muted">
                {row.enabled === undefined ? '—' : row.enabled ? 'enabled' : 'hidden'}
              </Cell>
              <Cell className="font-mono text-xs text-muted">{row.groupId ?? '—'}</Cell>
              <Cell className="font-mono text-xs text-muted">{row.upstreamModel ?? '—'}</Cell>
            </tr>
          ))}
        </Table>
      )}

      <Button
        className="w-full"
        icon="check"
        busy={busy}
        disabled={rows.length === 0}
        onClick={() => onApply(rows)}
      >
        Apply {rows.length} model{rows.length === 1 ? '' : 's'}
      </Button>
      <p className="text-xs text-muted">
        Every listed model is written in one transaction; a rejected row stops the whole batch. Ids
        the catalog does not hold are reported back instead of created — add a model first, or sync
        from OmniRoute.
      </p>
    </div>
  );
}

function ModelEditor({
  model,
  groups,
  onChange,
  isEdit
}: {
  model: ModelInput;
  groups: Array<{ id: string; name: string; enabled: boolean }>;
  onChange: (model: ModelInput) => void;
  isEdit: boolean;
}) {
  // Price fields render through PriceInput so fractional rates stay typeable;
  // a plain numeric() binding snapped `0.` to `0` and made sub-cent prices
  // impossible to enter.

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Model id" hint={isEdit ? 'Read-only: identifier cannot change after creation' : 'Lowercase, 2–64, used in the API'}>
        <input
          className={inputClass}
          value={model.id}
          readOnly={isEdit}
          disabled={isEdit}
          onChange={(event) => onChange({ ...model, id: event.target.value })}
          placeholder="lwrr-text"
        />
      </Field>
      <Field label="Display name">
        <input
          className={inputClass}
          value={model.name}
          onChange={(event) => onChange({ ...model, name: event.target.value })}
          placeholder="Lightweight text"
        />
      </Field>
      <Field label="Provider">
        <select
          className={inputClass}
          value={model.provider}
          onChange={(event) =>
            onChange({ ...model, provider: event.target.value as ModelInput['provider'] })
          }
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="google">google</option>
          <option value="meta">meta</option>
          <option value="other">other</option>
        </select>
      </Field>
      <Field label="Upstream model">
        <input
          className={inputClass}
          value={model.upstreamModel}
          onChange={(event) => onChange({ ...model, upstreamModel: event.target.value })}
          placeholder="auto"
        />
      </Field>
      <Field label="Model group" hint="A model outside a group cannot be resolved by a tenant">
        <select
          className={inputClass}
          value={model.groupId ?? ''}
          onChange={(event) => onChange({ ...model, groupId: event.target.value })}
        >
          <option value="">— no group —</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Input (₵ / 1M)" hint="Decimals allowed — vendors quote sub-cent rates">
        <PriceInput
          label="Input price per million tokens"
          value={model.inputPriceCents}
          onChange={(value) => onChange({ ...model, inputPriceCents: value })}
          placeholder="0.002"
        />
      </Field>
      <Field label="Output (₵ / 1M)" hint="Decimals allowed — vendors quote sub-cent rates">
        <PriceInput
          label="Output price per million tokens"
          value={model.outputPriceCents}
          onChange={(value) => onChange({ ...model, outputPriceCents: value })}
          placeholder="0.002"
        />
      </Field>
      <Field label="Cache read (₵ / 1M)" hint="Decimals allowed — vendors quote sub-cent rates">
        <PriceInput
          label="Cache read price per million tokens"
          value={model.cacheReadPriceCents}
          onChange={(value) => onChange({ ...model, cacheReadPriceCents: value })}
          placeholder="0.002"
        />
      </Field>
      <Field label="Multimodal">
        <select
          className={inputClass}
          value={model.multimodalSupport ? 'yes' : 'no'}
          onChange={(event) =>
            onChange({ ...model, multimodalSupport: event.target.value === 'yes' })
          }
        >
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="accent-brand"
          checked={model.enabled ?? false}
          onChange={(event) => onChange({ ...model, enabled: event.target.checked })}
        />
        Enabled in the gateway
      </label>
    </div>
  );
}

export function Admin() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [totals, setTotals] = useState<{
    accounts: number;
    active_subscriptions: number;
    wallet_tokens: number;
    units_today: number;
  } | null>(null);
  const [revenue, setRevenue] = useState(0);
  const [plans, setPlans] = useState<Plan[]>([]);
    const [catalog, setCatalog] = useState<
      Array<{
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
      }>
    >([]);
  const [policies, setPolicies] = useState<
    Array<{ tenant_id: string; model_id: string; enabled: number }>
  >([]);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [payments, setPayments] = useState<Array<Record<string, string | number | null>>>([]);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [modelEditor, setModelEditor] = useState<ModelInput | null>(null);
  const [modelPage, setModelPage] = useState(1);
  const [removingModel, setRemovingModel] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const [syncingModels, setSyncingModels] = useState(false);
  // Reset mode: also removes catalog models OmniRoute no longer lists, so the
  // catalog stays in step with upstream across repeated syncs. Protected by a
  // toggle because the extra removals are irreversible from the console alone.
  const [syncReset, setSyncReset] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [creditFor, setCreditFor] = useState<AdminAccount | null>(null);
  const [creditTokens, setCreditTokens] = useState(100_000);
  const [creditReason, setCreditReason] = useState('goodwill');
  const [limitsFor, setLimitsFor] = useState<AdminAccount | null>(null);
  const [limits, setLimits] = useState<TenantLimits>(BLANK_LIMITS);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [overview, planList, modelList, groupList, accountList, paymentList] = await Promise.all([
        api.admin.overview(),
        api.admin.plans(),
        api.admin.models(),
        api.admin.modelGroups(),
        api.admin.accounts(),
        api.admin.payments()
      ]);
      setTotals(overview.totals);
      setRevenue(overview.revenue_cents);
      setPlans(planList.plans);
      setCatalog(modelList.catalog);
      setGroups(groupList.groups);
      setPolicies(modelList.policies);
      setAccounts(accountList.accounts);
      setPayments(paymentList.payments);
      setDenied(null);
    } catch (error) {
      // Access sits in front of this page, so a rejection here means the
      // identity is real but not entitled. Say so plainly.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setDenied(error.message);
      } else {
        toast(error instanceof ApiError ? error.message : 'Could not load admin data', 'bad');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Mount-only: load() reads no reactive value, so an empty dependency list is
    // correct. eslint-plugin-react-hooks is deliberately not a dependency of this
    // repository, so there is no rule to suppress here.
  }, []);

  async function savePlan() {
    if (!editing) return;
    setBusy(true);
    try {
      await api.admin.savePlan(editing);
      toast(`${editing.name} saved`);
      setEditing(null);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not save the plan', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function saveLimits() {
    if (!limitsFor) return;
    setBusy(true);
    try {
      await api.admin.setLimits({ tenantId: limitsFor.tenantId, ...limits });
      toast(`Limits updated for ${limitsFor.email}`);
      setLimitsFor(null);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not update limits', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function saveModel() {
    if (!modelEditor) return;
    setBusy(true);
    try {
      if (modelEditor.id && catalog.some((model) => model.id === modelEditor.id)) {
        const { id, ...updates } = modelEditor;
        await api.admin.updateModel(id, updates);
        toast(`${modelEditor.name} updated`);
      } else {
        await api.admin.createModel(modelEditor);
        toast(`${modelEditor.name} added`);
      }
      setModelEditor(null);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not save the model', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function syncModels(reset: boolean) {
    setSyncingModels(true);
    try {
      const result = await api.admin.syncModels({ reset });
      const added = result.added.length;
      const removed = result.removed.length;
      if (reset) {
        toast(
          removed > 0 || added > 0
            ? `Synced: ${added} added, ${removed} removed from OmniRoute`
            : 'Catalog already matches OmniRoute'
        );
      } else {
        toast(
          added > 0
            ? `${added} model${added === 1 ? '' : 's'} synced from OmniRoute`
            : 'No new models from OmniRoute'
        );
      }
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not sync models from OmniRoute', 'bad');
    } finally {
      setSyncingModels(false);
    }
  }

  async function applyBulkModels(rows: ReturnType<typeof parseBulkModels>['rows']) {
    setBulkBusy(true);
    try {
      const result = await api.admin.bulkUpdateModels(rows);
      toast(
        result.missing.length > 0
          ? `${result.updated.length} updated · ${result.missing.length} id${result.missing.length === 1 ? '' : 's'} not found`
          : `${result.updated.length} model${result.updated.length === 1 ? '' : 's'} updated`
      );
      setBulkOpen(false);
      setBulkText('');
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not apply bulk changes', 'bad');
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteModel(id: string) {
    setRemovingModel(id);
    try {
      await api.admin.deleteModel(id);
      toast('Model removed');
      const maxPage = Math.max(1, Math.ceil((catalog.length - 1) / MODEL_PAGE_SIZE));
      if (modelPage > maxPage) setModelPage(maxPage);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not remove the model', 'bad');
    } finally {
      setRemovingModel(null);
    }
  }

  function openModelEditor(model?: (typeof catalog)[number]) {
    setModelPage(1);
    setModelEditor(
      model
        ? {
            id: model.id,
            name: model.name,
            provider: model.provider as ModelInput['provider'],
            inputPriceCents: model.inputPriceCents,
            outputPriceCents: model.outputPriceCents,
            cacheReadPriceCents: model.cacheReadPriceCents,
            multimodalSupport: model.multimodalSupport,
            upstreamModel: model.upstreamModel,
            enabled: model.enabled,
            groupId: model.groupId ?? 'legacy-default'
          }
        : { ...BLANK_MODEL }
    );
  }

  if (denied) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-sm rounded-card border border-border bg-surface p-6 text-center shadow-card">
          <Icon name="shield" size={24} className="mx-auto text-warn" animate />
          <h1 className="mt-3 text-sm font-semibold">Admin access required</h1>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Your identity was verified by Cloudflare Access, but this account does not hold an admin
            or owner role on the gateway.
          </p>
        </div>
      </div>
    );
  }

  // 663 models paginate across dozens of pages; the filter lets an admin find a
  // model by id, display name, provider, or upstream path without paging.
  const query = modelFilter.trim().toLowerCase();
  const filteredCatalog = query
    ? catalog.filter(
        (model) =>
          model.id.toLowerCase().includes(query) ||
          model.name.toLowerCase().includes(query) ||
          model.provider.toLowerCase().includes(query) ||
          model.upstreamModel.toLowerCase().includes(query)
      )
    : catalog;

  return (
    <Shell title="Admin" subtitle="LeuwongRR gateway" items={NAV} active={tab} onSelect={setTab}>
      {loading ? (
        <Spinner label="Loading control plane" />
      ) : (
        <>
          {tab === 'overview' && totals && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Accounts" value={String(totals.accounts)} icon="users" />
              <Stat
                label="Active plans"
                value={String(totals.active_subscriptions)}
                icon="card"
                tone="good"
              />
              <Stat label="Wallet float" value={tokens(totals.wallet_tokens)} icon="wallet" />
              <Stat label="Units today" value={tokens(totals.units_today)} icon="activity" />
              <div className="sm:col-span-2 xl:col-span-4">
                <Card title="Revenue" subtitle="Settled Cryptomus invoices, all time">
                  <p className="text-3xl font-semibold tabular-nums">{money(revenue)}</p>
                </Card>
              </div>
            </div>
          )}

          {tab === 'plans' && (
            <Card
              title="Plans"
              subtitle="Price, allowance, and the operational envelope each plan grants"
              action={
                <Button icon="plus" onClick={() => setEditing({ ...BLANK_PLAN })}>
                  New plan
                </Button>
              }
            >
              <Table
                headers={['Plan', 'Price', 'Included', 'PAYG / M', 'Limits', 'State', '']}
                empty={plans.length === 0}
              >
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <Cell className="font-medium">
                      {plan.name}
                      <span className="ml-1.5 font-mono text-xs text-muted">
                        {plan.id}
                        {plan.modelGroupId ? ` · ${plan.modelGroupId}` : ''}
                      </span>
                    </Cell>
                    <Cell className="tabular-nums">{money(plan.monthlyPriceCents)}</Cell>
                    <Cell className="tabular-nums">{tokens(plan.includedTokens)}</Cell>
                    <Cell className="tabular-nums">{money(plan.overageCentsPerMillion)}</Cell>
                    <Cell className="whitespace-nowrap text-xs text-muted">
                      {plan.rateLimitRpm} rpm · {plan.maxConcurrent} conc
                    </Cell>
                    <Cell>
                      <Badge tone={plan.active ? 'good' : 'neutral'}>
                        {plan.active ? 'Offered' : 'Hidden'}
                      </Badge>
                    </Cell>
                    <Cell className="text-right">
                      <Button variant="outline" onClick={() => setEditing(plan)}>
                        Edit
                      </Button>
                    </Cell>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          {tab === 'models' && (
            <div className="space-y-4">
              <Card
                title="Model catalog"
                subtitle="Registered in the gateway and served through OmniRoute"
                action={
                  <div className="flex flex-col items-end gap-1.5">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        busy={syncingModels}
                        disabled={syncingModels}
                        onClick={() => void syncModels(syncReset)}
                      >
                        {syncReset ? 'Sync & reset catalog' : 'Sync from OmniRoute'}
                      </Button>
                      <Button variant="outline" icon="terminal" onClick={() => setBulkOpen(true)}>
                        Bulk edit
                      </Button>
                      <Button icon="plus" onClick={() => openModelEditor()}>
                        Add model
                      </Button>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted" title="Also removes models OmniRoute no longer lists. Models an active plan still uses are kept.">
                      <input
                        type="checkbox"
                        className="accent-brand"
                        checked={syncReset}
                        onChange={(event) => setSyncReset(event.target.checked)}
                      />
                      Reconcile with upstream (remove stale models)
                    </label>
                  </div>
                }
              >
                <div className="border-b border-border/70 px-4 py-3">
                  <input
                    className={inputClass}
                    value={modelFilter}
                    onChange={(event) => {
                      setModelFilter(event.target.value);
                      setModelPage(1);
                    }}
                    placeholder="Filter models by id, name, provider, or upstream…"
                  />
                </div>
                <Table
                  headers={['Model', 'Upstream', 'Group', 'In ₵/M', 'Out ₵/M', 'Cache ₵/M', 'State', '']}
                  empty={filteredCatalog.length === 0}
                >
                  {filteredCatalog
                    .slice((modelPage - 1) * MODEL_PAGE_SIZE, modelPage * MODEL_PAGE_SIZE)
                    .map((model) => (
                      <tr key={model.id}>
                        <Cell>
                          <p className="font-medium">{model.name}</p>
                          <p className="font-mono text-xs text-muted">{model.id}</p>
                        </Cell>
                        <Cell className="text-xs text-muted">{model.upstreamModel}</Cell>
                        <Cell className="text-xs text-muted">{model.groupId}</Cell>
                        <Cell className="tabular-nums">{model.inputPriceCents}</Cell>
                        <Cell className="tabular-nums">{model.outputPriceCents}</Cell>
                        <Cell className="tabular-nums">{model.cacheReadPriceCents}</Cell>
                        <Cell>
                          <Badge tone={model.enabled ? 'good' : 'neutral'}>
                            {model.enabled ? 'Enabled' : 'Hidden'}
                            {model.multimodalSupport ? ' · vision' : ''}
                          </Badge>
                        </Cell>
                        <Cell className="whitespace-nowrap text-right">
                          <Button variant="outline" onClick={() => openModelEditor(model)}>
                            Edit
                          </Button>
                          <Button
                            variant="danger"
                            className="ml-1.5"
                            busy={removingModel === model.id}
                            disabled={removingModel !== null}
                            onClick={() => void deleteModel(model.id)}
                          >
                            Remove
                          </Button>
                        </Cell>
                      </tr>
                    ))}
                </Table>
                {filteredCatalog.length > MODEL_PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-border/70 px-4 py-3 text-xs text-muted">
                    <span>
                      {filteredCatalog.length} model{filteredCatalog.length === 1 ? '' : 's'} · page {modelPage}/
                      {Math.ceil(filteredCatalog.length / MODEL_PAGE_SIZE)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        disabled={modelPage === 1}
                        onClick={() => setModelPage((p) => Math.max(1, p - 1))}
                      >
                        Prev
                      </Button>
                      <Button
                        variant="outline"
                        disabled={modelPage >= Math.ceil(filteredCatalog.length / MODEL_PAGE_SIZE)}
                        onClick={() => setModelPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
              <Card title="Entitlements" subtitle="Per tenant model access">
                <Table headers={['Tenant', 'Model', 'Access', '']} empty={policies.length === 0}>
                  {policies.map((policy) => (
                    <tr key={`${policy.tenant_id}:${policy.model_id}`}>
                      <Cell className="font-mono text-xs">{policy.tenant_id}</Cell>
                      <Cell className="font-mono text-xs">{policy.model_id}</Cell>
                      <Cell>
                        <Badge tone={policy.enabled ? 'good' : 'bad'}>
                          {policy.enabled ? 'Enabled' : 'Blocked'}
                        </Badge>
                      </Cell>
                      <Cell className="text-right">
                        <Button
                          variant="outline"
                          onClick={() =>
                              void api.admin
                                .setModelPolicy(policy.tenant_id, policy.model_id, !policy.enabled)
                                .then(load)
                          }
                        >
                          {policy.enabled ? 'Disable' : 'Enable'}
                        </Button>
                      </Cell>
                    </tr>
                  ))}
                </Table>
              </Card>
            </div>
          )}

          {tab === 'accounts' && (
            <Card title="Accounts" subtitle="Balances reflect the same ledger the gateway enforces">
              <Table
                headers={['Account', 'Role', 'Plan', 'Available', 'Today', 'State', '']}
                empty={accounts.length === 0}
              >
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <Cell>
                      <p className="font-medium">{account.email}</p>
                      <p className="font-mono text-xs text-muted">{account.tenantId}</p>
                    </Cell>
                    <Cell className="text-xs text-muted">{account.role}</Cell>
                    <Cell className="text-xs">{account.billing.plan?.name ?? '—'}</Cell>
                    <Cell className="tabular-nums">{tokens(account.billing.totalAvailable)}</Cell>
                    <Cell className="tabular-nums text-muted">{tokens(account.billing.usageToday)}</Cell>
                    <Cell>
                      <Badge tone={account.status === 'active' ? 'good' : 'bad'}>{account.status}</Badge>
                    </Cell>
                    <Cell className="whitespace-nowrap text-right">
                      <Button
                        variant="outline"
                        onClick={() => {
                          // The stored envelope, not the plan's copy of it. A
                          // plan describes what was applied when the
                          // subscription started; seeding from it discarded
                          // every later limit edit on the next save.
                          setLimits({
                            dailyBudgetUnits: account.limits.dailyBudgetUnits,
                            maxConcurrent: account.limits.maxConcurrent,
                            rateLimitRpm: account.limits.rateLimitRpm
                          });
                          setLimitsFor(account);
                        }}
                      >
                        Limits
                      </Button>
                      <Button
                        variant="outline"
                        className="ml-1.5"
                        onClick={() => setCreditFor(account)}
                      >
                        Credit
                      </Button>
                      <Button
                        variant={account.status === 'active' ? 'danger' : 'outline'}
                        className="ml-1.5"
                        onClick={() =>
                          void api.admin
                            .setStatus(
                              account.id,
                              account.status === 'active' ? 'suspended' : 'active'
                            )
                            .then(load)
                        }
                      >
                        {account.status === 'active' ? 'Suspend' : 'Restore'}
                      </Button>
                    </Cell>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          {tab === 'payments' && (
            <Card title="Payments" subtitle="Cryptomus invoices across every account">
              <Table
                headers={['Order', 'Account', 'Purpose', 'Tokens', 'Amount', 'Status', 'Settled']}
                empty={payments.length === 0}
              >
                {payments.map((payment) => (
                  <tr key={String(payment.order_id)}>
                    <Cell className="font-mono text-xs text-muted">
                      {String(payment.order_id).slice(0, 18)}
                    </Cell>
                    <Cell className="font-mono text-xs">{String(payment.account_id).slice(0, 12)}</Cell>
                    <Cell>{String(payment.purpose)}</Cell>
                    <Cell className="tabular-nums">{tokens(Number(payment.tokens ?? 0))}</Cell>
                    <Cell className="tabular-nums">{money(Number(payment.amount_cents ?? 0))}</Cell>
                    <Cell>
                      <Badge tone={String(payment.status).startsWith('paid') ? 'good' : 'warn'}>
                        {String(payment.status)}
                      </Badge>
                    </Cell>
                    <Cell className="whitespace-nowrap text-muted">
                      {payment.settled_at ? dateTime(String(payment.settled_at)) : '—'}
                    </Cell>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          <Modal open={editing !== null} title="Plan" onClose={() => setEditing(null)}>
            {editing && (
              <div className="space-y-4">
                <PlanEditor plan={editing} groups={groups} onChange={setEditing} />
                <Button
                  className="w-full"
                  icon="check"
                  busy={busy}
                  disabled={planSaveDisabled(editing)}
                  onClick={() => void savePlan()}
                >
                  Save plan
                </Button>
              </div>
            )}
          </Modal>

          <Modal
            open={modelEditor !== null}
            title={modelEditor && catalog.some((model) => model.id === modelEditor.id) ? 'Edit model' : 'Add model'}
            onClose={() => setModelEditor(null)}
          >
            {modelEditor && (
              <div className="space-y-4">
                <ModelEditor
                  model={modelEditor}
                  groups={groups}
                  onChange={setModelEditor}
                  isEdit={catalog.some((model) => model.id === modelEditor.id)}
                />
                <Button
                  className="w-full"
                  icon="check"
                  busy={busy}
                  disabled={modelSaveDisabled(modelEditor)}
                  onClick={() => void saveModel()}
                >
                  Save model
                </Button>
              </div>
            )}
          </Modal>

          <Modal open={bulkOpen} title="Bulk edit models" onClose={() => setBulkOpen(false)}>
            <BulkModelsEditor
              text={bulkText}
              onChange={setBulkText}
              onApply={(rows) => void applyBulkModels(rows)}
              busy={bulkBusy}
            />
          </Modal>

          <Modal open={creditFor !== null} title="Credit tokens" onClose={() => setCreditFor(null)}>
            {creditFor && (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  Adds tokens to {creditFor.email} and records an audited ledger adjustment.
                </p>
                <Field label="Tokens">
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    value={creditTokens}
                    onChange={(event) => setCreditTokens(Number(event.target.value))}
                  />
                </Field>
                <Field label="Reason">
                  <input
                    className={inputClass}
                    value={creditReason}
                    onChange={(event) => setCreditReason(event.target.value)}
                  />
                </Field>
                <Button
                  className="w-full"
                  icon="wallet"
                  busy={busy}
                  onClick={() =>
                    void api.admin
                      .credit(creditFor.id, creditTokens, creditReason)
                      .then(() => {
                        toast('Credit applied');
                        setCreditFor(null);
                        return load();
                      })
                      .catch((error: unknown) =>
                        toast(error instanceof ApiError ? error.message : 'Credit failed', 'bad')
                      )
                  }
                >
                  Apply credit
                </Button>
              </div>
            )}
          </Modal>

          <Modal open={limitsFor !== null} title="Tenant limits" onClose={() => setLimitsFor(null)}>
            {limitsFor && (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  Sets the enforced envelope for{' '}
                  <span className="font-mono text-xs">{limitsFor.tenantId}</span>.{' '}
                  {limitsFor.limits.stored
                    ? 'These are the values currently stored and enforced.'
                    : 'No stored limits yet, so the gateway defaults are shown.'}{' '}
                  A later plan change overwrites these values.
                </p>
                <Field label="Daily budget units" hint="0 blocks the tenant for the rest of the day">
                  <input
                    className={inputClass}
                    type="number"
                    min={DAILY_BUDGET_UNITS.min}
                    max={DAILY_BUDGET_UNITS.max}
                    value={formatLimitInput(limits.dailyBudgetUnits)}
                    onChange={(event) =>
                      setLimits({ ...limits, dailyBudgetUnits: parseLimitInput(event.target.value) })
                    }
                  />
                </Field>
                <Field label="Max concurrent">
                  <input
                    className={inputClass}
                    type="number"
                    min={MAX_CONCURRENT.min}
                    max={MAX_CONCURRENT.max}
                    value={formatLimitInput(limits.maxConcurrent)}
                    onChange={(event) =>
                      setLimits({ ...limits, maxConcurrent: parseLimitInput(event.target.value) })
                    }
                  />
                </Field>
                <Field label="Rate limit (rpm)">
                  <input
                    className={inputClass}
                    type="number"
                    min={RATE_LIMIT_RPM.min}
                    max={RATE_LIMIT_RPM.max}
                    value={formatLimitInput(limits.rateLimitRpm)}
                    onChange={(event) =>
                      setLimits({ ...limits, rateLimitRpm: parseLimitInput(event.target.value) })
                    }
                  />
                </Field>
                <Button
                  className="w-full"
                  icon="gauge"
                  busy={busy}
                  disabled={limitsSaveDisabled(limits)}
                  onClick={() => void saveLimits()}
                >
                  Save limits
                </Button>
              </div>
            )}
          </Modal>
        </>
      )}
    </Shell>
  );
}

// Guard the mount so importing this module has no side effect off the page:
// the DOM behavioural tests import `Admin` directly and there is no #root then,
// while admin.html always provides one in the browser.
const rootElement = document.getElementById('root');
if (rootElement) {
  applyStoredTheme();
  createRoot(rootElement).render(
    <StrictMode>
      <ToastHost>
        <Admin />
      </ToastHost>
    </StrictMode>
  );
}
