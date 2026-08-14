import type { Database } from 'better-sqlite3';
import { z } from 'zod';

export const modelGroupInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(64),
  multiplierBps: z.number().int().min(1).max(1_000_000),
  enabled: z.boolean().optional()
}).strict();

export type ModelGroupInput = z.infer<typeof modelGroupInputSchema>;
export interface ModelGroupRecord {
  id: string;
  name: string;
  multiplierBps: number;
  enabled: boolean;
}

export class ModelGroupError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'ModelGroupError';
  }
}

interface GroupRow { id: string; name: string; multiplier_bps: number; enabled: number }

function toRecord(row: GroupRow): ModelGroupRecord {
  return { id: row.id, name: row.name, multiplierBps: row.multiplier_bps, enabled: row.enabled === 1 };
}

export class ModelGroupCatalog {
  constructor(private readonly db: Database) {}

  list(): ModelGroupRecord[] {
    return (this.db.prepare('SELECT id, name, multiplier_bps, enabled FROM model_groups ORDER BY name').all() as GroupRow[]).map(toRecord);
  }

  get(id: string): ModelGroupRecord | null {
    const row = this.db.prepare('SELECT id, name, multiplier_bps, enabled FROM model_groups WHERE id = ?').get(id) as GroupRow | undefined;
    return row ? toRecord(row) : null;
  }

  create(input: ModelGroupInput): ModelGroupRecord {
    try {
      this.db.prepare('INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))').run(input.id, input.name, input.multiplierBps, input.enabled === false ? 0 : 1);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new ModelGroupError('group_already_exists', 409);
      throw error;
    }
    return this.get(input.id) as ModelGroupRecord;
  }

  update(id: string, input: Omit<ModelGroupInput, 'id'>): ModelGroupRecord {
    const result = this.db.prepare('UPDATE model_groups SET name = ?, multiplier_bps = ?, enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(input.name, input.multiplierBps, input.enabled === false ? 0 : 1, id);
    if (result.changes === 0) throw new ModelGroupError('group_not_found', 404);
    return this.get(id) as ModelGroupRecord;
  }

  assignModel(groupId: string, modelId: string): void {
    if (!this.get(groupId)) throw new ModelGroupError('group_not_found', 404);
    const result = this.db.prepare('UPDATE models SET group_id = ?, updated_at = datetime(\'now\') WHERE public_id = ?').run(groupId, modelId);
    if (result.changes === 0) throw new ModelGroupError('model_not_found', 404);
  }

  unassignModel(modelId: string): void {
    const result = this.db.prepare('UPDATE models SET group_id = NULL, updated_at = datetime(\'now\') WHERE public_id = ?').run(modelId);
    if (result.changes === 0) throw new ModelGroupError('model_not_found', 404);
  }

  remove(id: string): void {
    if ((this.db.prepare('SELECT 1 FROM plans WHERE model_group_id = ? LIMIT 1').get(id))) throw new ModelGroupError('group_in_use', 409);
    const result = this.db.prepare('DELETE FROM model_groups WHERE id = ?').run(id);
    if (result.changes === 0) throw new ModelGroupError('group_not_found', 404);
  }
}
