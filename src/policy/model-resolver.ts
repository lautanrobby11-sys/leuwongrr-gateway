import type { Database } from 'better-sqlite3';
import type { Capability } from './capabilities.js';

export class ModelResolutionError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'ModelResolutionError';
  }
}

interface ModelRow {
  public_id: string;
  upstream_model: string;
  enabled: number;
  group_id: string | null;
  capabilities_json: string;
  max_output_tokens: number;
}

export interface ResolvedCatalogModel {
  id: string;
  upstreamModel: string;
  capabilities: ReadonlySet<Capability>;
  maxOutputTokens: number;
}

export function resolveCatalogModel(
  db: Database,
  publicId: string,
  required: readonly Capability[],
  tenantId: string,
  accountId: string | null
): ResolvedCatalogModel {
  const model = db.prepare('SELECT public_id, upstream_model, enabled, group_id, capabilities_json, max_output_tokens FROM models WHERE public_id = ?').get(publicId) as ModelRow | undefined;
  if (!model) throw new ModelResolutionError('model_not_found', 404);
  if (model.enabled !== 1) throw new ModelResolutionError('model_unavailable', 404);
  if (!model.group_id) throw new ModelResolutionError('model_group_missing', 503);

  const group = db.prepare('SELECT id, enabled FROM model_groups WHERE id = ?').get(model.group_id) as { id: string; enabled: number } | undefined;
  if (!group || group.enabled !== 1) throw new ModelResolutionError('model_unavailable', 404);

  if (accountId !== null) {
    // Evaluate every active subscription rather than only the newest row: an
    // account may carry both a rolling timer and stacked packs, and either group
    // may entitle the model. `datetime()` normalizes stored ISO timestamps so
    // the comparison is not string-ordered, and the plan's current group is used
    // only as a fallback when the subscription snapshot has none.
    const subscriptions = db
      .prepare(
        `SELECT s.model_group_id AS subscription_group_id, p.model_group_id AS plan_group_id
           FROM subscriptions s
           LEFT JOIN plans p ON p.id = s.plan_id
          WHERE s.account_id = ?
            AND s.status = 'active'
            AND datetime(s.period_end) > datetime('now')
          ORDER BY s.created_at, s.id`
      )
      .all(accountId) as Array<{ subscription_group_id: string | null; plan_group_id: string | null }>;
    if (subscriptions.length === 0) throw new ModelResolutionError('model_not_entitled', 403);
    const resolved = subscriptions.map((entry) => entry.subscription_group_id ?? entry.plan_group_id);
    if (resolved.every((groupId) => groupId === null)) throw new ModelResolutionError('plan_group_missing', 503);
    if (!resolved.includes(model.group_id)) throw new ModelResolutionError('model_not_entitled', 403);
  } else {
    // Non-console deployments retain the pre-billing tenant allow-list. An API
    // key without a console account must never become entitled merely because
    // the catalog model and its legacy group exist.
    const legacyPolicy = db
      .prepare('SELECT enabled FROM model_policies WHERE tenant_id = ? AND model_id = ?')
      .get(tenantId, publicId) as { enabled: number } | undefined;
    if (legacyPolicy?.enabled !== 1) throw new ModelResolutionError('model_not_entitled', 403);
  }

  const denied = db.prepare('SELECT enabled FROM model_policies WHERE tenant_id = ? AND model_id = ?').get(tenantId, publicId) as { enabled: number } | undefined;
  if (denied?.enabled === 0) throw new ModelResolutionError('model_not_entitled', 403);

  let capabilities: Capability[];
  try {
    const parsed = JSON.parse(model.capabilities_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error('capabilities_not_array');
    }
    capabilities = parsed as Capability[];
  } catch { throw new ModelResolutionError('model_unavailable', 503); }
  for (const capability of required) {
    if (!capabilities.includes(capability)) throw new ModelResolutionError(`capability_${capability}_unsupported`, 400);
  }
  return { id: model.public_id, upstreamModel: model.upstream_model, capabilities: new Set(capabilities), maxOutputTokens: model.max_output_tokens };
}
