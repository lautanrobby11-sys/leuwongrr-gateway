import type { BulkModelRow } from '../lib/api';

export interface BulkParseIssue {
  /** 1-based line number in the textarea the operator read. */
  line: number;
  reason: string;
}

export interface BulkParseResult {
  rows: BulkModelRow[];
  issues: BulkParseIssue[];
}

const MODEL_ID = /^[a-z0-9-]{2,64}$/;
const GROUP_ID = /^[a-z0-9-]{2,32}$/;

/** The placeholder that means "leave this field as it is". */
const SKIP = new Set(['', '-']);

/**
 * Parses the bulk-edit textarea: one model per line, fields separated by
 * commas or pipes, in the fixed order
 *
 *   id, input ₵/M, output ₵/M, cache read ₵/M, enabled, group, upstream
 *
 * A `-` (or an empty trailing field) leaves that attribute untouched, so an
 * operator can reprice a whole catalogue without re-typing the fields that do
 * not change. `#` starts a comment line. Bounds mirror the single-model
 * editor's schema so the preview the operator sees is the payload the server
 * accepts; anything else becomes a per-line issue rather than a silent drop.
 */
export function parseBulkModels(text: string): BulkParseResult {
  const rows: BulkModelRow[] = [];
  const issues: BulkParseIssue[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = (lines[index] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const line = index + 1;
    const fields = raw.split(/[,|]/).map((field) => field.trim());
    const [id, inRaw, outRaw, cacheRaw, enabledRaw, groupRaw, upstreamRaw] = fields;

    if (!id || !MODEL_ID.test(id)) {
      issues.push({ line, reason: `"${id ?? ''}" is not a model id (lowercase, 2-64)` });
      continue;
    }
    if (fields.length < 2) {
      issues.push({ line, reason: 'No fields to change — add at least one value after the id' });
      continue;
    }
    if (fields.length > 7) {
      issues.push({
        line,
        reason: `Too many fields (${fields.length}) — at most id, input, output, cache read, enabled, group, upstream`
      });
      continue;
    }

    const row: BulkModelRow = { id };
    let invalid = false;

    const price = (value: string | undefined, label: string): void => {
      if (value === undefined || SKIP.has(value)) return;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
        invalid = true;
        issues.push({ line, reason: `${label} "${value}" is not between 0 and 1,000,000 cents` });
        return;
      }
      if (label === 'input') row.inputPriceCents = parsed;
      if (label === 'output') row.outputPriceCents = parsed;
      if (label === 'cache read') row.cacheReadPriceCents = parsed;
    };
    price(inRaw, 'input');
    price(outRaw, 'output');
    price(cacheRaw, 'cache read');

    if (enabledRaw !== undefined && !SKIP.has(enabledRaw)) {
      if (['true', '1', 'yes'].includes(enabledRaw.toLowerCase())) row.enabled = true;
      else if (['false', '0', 'no'].includes(enabledRaw.toLowerCase())) row.enabled = false;
      else {
        invalid = true;
        issues.push({ line, reason: `enabled "${enabledRaw}" is not true/false` });
      }
    }

    if (groupRaw !== undefined && !SKIP.has(groupRaw)) {
      if (!GROUP_ID.test(groupRaw)) {
        invalid = true;
        issues.push({ line, reason: `group "${groupRaw}" is not a group id (lowercase, 2-32)` });
      } else {
        row.groupId = groupRaw;
      }
    }

    if (upstreamRaw !== undefined && !SKIP.has(upstreamRaw)) {
      if (upstreamRaw.length > 128) {
        invalid = true;
        issues.push({ line, reason: `upstream "${upstreamRaw}" is longer than 128 characters` });
      } else {
        row.upstreamModel = upstreamRaw;
      }
    }

    // A row whose every field after the id is `-` or empty would pass field
    // validation yet change nothing — the server answers 400 for it, so the
    // preview must flag it here rather than offer an Apply that cannot land.
    if (!invalid && Object.keys(row).length < 2) {
      issues.push({ line, reason: 'No fields to change — every field after the id is "-" or empty' });
      continue;
    }
    if (!invalid) rows.push(row);
  }
  return { rows, issues };
}
