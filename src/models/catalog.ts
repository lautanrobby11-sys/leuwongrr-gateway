import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Release 2a model catalog (Boss spec): the `models` table is the admin-owned
 * registry of models reachable through OmniRoute. The static registry in
 * `src/policy/capabilities.ts` remains the request-path source of truth; this
 * store is what the admin CRUD writes and reads.
 */

export const MODEL_PROVIDERS = ['openai', 'anthropic', 'google', 'meta', 'other'] as const;

/**
 * One definition of what a model entry may contain, shared by the admin console
 * route and (in the future) the operator CLI. Numeric bounds are plan-shaped:
 * prices are cents per million tokens, never negative, and small enough that a
 * typo cannot produce an absurd invoice.
 */
export const modelInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,64}$/),
    name: z.string().min(1).max(64),
    provider: z.enum(MODEL_PROVIDERS),
    inputPriceCents: z.number().finite().int().min(0).max(1_000_000),
    outputPriceCents: z.number().finite().int().min(0).max(1_000_000),
    cacheReadPriceCents: z.number().finite().int().min(0).max(1_000_000),
    multimodalSupport: z.boolean(),
    upstreamModel: z.string().min(1).max(64),
    enabled: z.boolean().optional()
  })
  .strict();

export const modelUpdateSchema = modelInputSchema.omit({ id: true }).partial().strict();

export type ModelInput = z.infer<typeof modelInputSchema>;
export type ModelUpdate = z.infer<typeof modelUpdateSchema>;

export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  inputPriceCents: number;
  outputPriceCents: number;
  cacheReadPriceCents: number;
  multimodalSupport: boolean;
  upstreamModel: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ModelRow {
  id: string;
  public_id: string;
  display_name: string;
  provider: string;
  multimodal: number;
  input_price_cents: number;
  output_price_cents: number;
  cache_read_price_cents: number;
  upstream_model: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class ModelError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
    this.name = 'ModelError';
  }
}

function toRecord(row: ModelRow): ModelRecord {
  return {
    id: row.public_id,
    name: row.display_name,
    provider: row.provider,
    inputPriceCents: row.input_price_cents,
    outputPriceCents: row.output_price_cents,
    cacheReadPriceCents: row.cache_read_price_cents,
    multimodalSupport: row.multimodal === 1,
    upstreamModel: row.upstream_model,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class ModelCatalog {
  constructor(private readonly db: Database) {}

  list(): ModelRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM models ORDER BY display_name')
      .all() as ModelRow[];
    return rows.map(toRecord);
  }

  get(id: string): ModelRecord | null {
    const row = this.db.prepare('SELECT * FROM models WHERE public_id = ?').get(id) as
      | ModelRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  create(input: ModelInput): ModelRecord {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, enabled, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          input.id,
          input.name,
          input.provider,
          input.multimodalSupport ? 1 : 0,
          0,
          0,
          0,
          0,
          input.enabled === false ? 0 : 1,
          input.inputPriceCents,
          input.outputPriceCents,
          input.cacheReadPriceCents,
          input.upstreamModel,
          now,
          now
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new ModelError('model_already_exists', 409);
      }
      throw error;
    }
    const stored = this.get(input.id);
    if (!stored) throw new ModelError('model_write_failed', 500);
    return stored;
  }

  update(id: string, input: ModelUpdate): ModelRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE models SET display_name = ?, provider = ?, multimodal = ?, enabled = ?, input_price_cents = ?, output_price_cents = ?, cache_read_price_cents = ?, upstream_model = ?, updated_at = ?
         WHERE public_id = ?`
      )
      .run(
        input.name ?? existing.name,
        input.provider ?? existing.provider,
        input.multimodalSupport !== undefined ? (input.multimodalSupport ? 1 : 0) : (existing.multimodalSupport ? 1 : 0),
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        input.inputPriceCents ?? existing.inputPriceCents,
        input.outputPriceCents ?? existing.outputPriceCents,
        input.cacheReadPriceCents ?? existing.cacheReadPriceCents,
        input.upstreamModel ?? existing.upstreamModel,
        now,
        id
      );
    return this.get(id);
  }

  /**
   * A model that an active plan entitles subscribers to must survive: deleting
   * it would silently break the entitlement. The plan stores model ids as a
   * JSON array, so the guard reads and parses rather than guessing at LIKE
   * fragments.
   */
  remove(id: string): void {
    const plans = this.db
      .prepare("SELECT id, models_json FROM plans WHERE active = 1")
      .all() as Array<{ id: string; models_json: string }>;
    for (const plan of plans) {
      const models = JSON.parse(plan.models_json) as string[];
      if (models.includes(id)) {
        throw new ModelError('model_in_use_by_plan', 409);
      }
    }
    const apply = this.db.transaction(() => {
      this.db.prepare('DELETE FROM model_policies WHERE model_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM models WHERE public_id = ?').run(id);
      if (result.changes === 0) throw new ModelError('model_not_found', 404);
    });
    apply();
  }
}
