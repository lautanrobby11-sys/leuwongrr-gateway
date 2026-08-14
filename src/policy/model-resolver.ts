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
  accountId: string
): ResolvedCatalogModel {
  const model = db.prepare('SELECT public_id, upstream_model, enabled, group_id, capabilities_json, max_output_tokens FROM models WHERE public_id = ?').get(publicId) as ModelRow | undefined;
  if (!model) throw new ModelResolutionError('model_not_found', 404);
  if (model.enabled !== 1) throw new ModelResolutionError('model_unavailable', 404);
  if (!model.group_id) throw new ModelResolutionError('model_group_missing', 503);

  const group = db.prepare('SELECT id, enabled FROM model_groups WHERE id = ?').get(model.group_id) as { id: string; enabled: number } | undefined;
  if (!group || group.enabled !== 1) throw new ModelResolutionError('model_unavailable', 404);

  const subscription = db.prepare("SELECT s.model_group_id AS subscription_group_id, s.status FROM subscriptions s WHERE s.account_id = ? AND s.status = 'active' AND s.period_end > datetime('now') ORDER BY s.created_at DESC LIMIT 1").get(accountId) as { subscription_group_id: string | null; status: string } | undefined;
  if (!subscription) throw new ModelResolutionError('model_not_entitled', 403);
  if (!subscription.subscription_group_id) {
    const plan = db.prepare('SELECT p.model_group_id AS plan_group_id FROM plans p JOIN subscriptions s ON s.plan_id = p.id WHERE s.account_id = ? AND s.status = \'active\' ORDER BY s.created_at DESC LIMIT 1').get(accountId) as { plan_group_id: string | null } | undefined;
    if (!plan?.plan_group_id) throw new ModelResolutionError('plan_group_missing', 503);
    if (plan.plan_group_id !== model.group_id) throw new ModelResolutionError('model_not_entitled', 403);
  } else if (subscription.subscription_group_id !== model.group_id) {
    throw new ModelResolutionError('model_not_entitled', 403);
  }

  const denied = db.prepare('SELECT enabled FROM model_policies WHERE tenant_id = ? AND model_id = ?').get(tenantId, publicId) as { enabled: number } | undefined;
  if (denied?.enabled === 0) throw new ModelResolutionError('model_not_entitled', 403);

  let capabilities: Capability[];
  try { capabilities = JSON.parse(model.capabilities_json) as Capability[]; } catch { throw new ModelResolutionError('model_unavailable', 503); }
  for (const capability of required) {
    if (!capabilities.includes(capability)) throw new ModelResolutionError(`capability_${capability}_unsupported`, 400);
  }
  return { id: model.public_id, upstreamModel: model.upstream_model, capabilities: new Set(capabilities), maxOutputTokens: model.max_output_tokens };
}
