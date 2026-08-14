import { afterEach, describe, expect, it } from 'vitest';
import { BillingService } from '../src/billing/service.js';
import { createTempDatabase } from './support/harness.js';

let fixture: ReturnType<typeof createTempDatabase> | null = null;
afterEach(() => { fixture?.dispose(); fixture = null; });

describe('member plan catalog', () => {
  it('projects enabled group models with effective prices and hides upstream names', () => {
    fixture = createTempDatabase();
    const { db } = fixture;
    db.db.prepare("INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES ('value', 'Value', 12500, 1, datetime('now'), datetime('now'))").run();
    db.db.prepare("INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, enabled, created_at, updated_at, group_id) VALUES ('value-text-id', 'value-text', 'Value Text', 'other', 0, 0, 0, 0, 0, 101, 201, 51, 'secret-upstream', 1, datetime('now'), datetime('now'), 'value')").run();
    db.db.prepare("INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at, model_group_id) VALUES ('value-plan', 'Value Plan', 100, 1000, 10, 1, 1, 1000, '[]', 1, datetime('now'), 'value')").run();

    const plans = new BillingService(db.db).listMemberPlans();
    expect(plans[0]).toMatchObject({ id: 'value-plan', modelGroupId: 'value' });
    expect(plans[0].eligibleModels[0]).toMatchObject({
      id: 'value-text',
      inputPriceCents: 101,
      effectiveInputPriceCents: 127,
      effectiveOutputPriceCents: 252,
      effectiveCacheReadPriceCents: 64
    });
    expect(plans[0].eligibleModels[0]).not.toHaveProperty('upstreamModel');
  });
});
