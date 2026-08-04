import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A pure function that nothing calls is not a fix.
 *
 * `parseLimitInput` and `formatLimitInput` were added and unit-tested while the
 * limits modal still read `Number(event.target.value)`, so the defect they were
 * written for — a cleared field becoming a legal `0` that quarantines the tenant
 * for the rest of the day — stayed live in the shipped form. The review thread
 * was closed on the strength of the helper existing.
 *
 * These assertions read the component source instead of rendering it. That is a
 * deliberate trade: the repository carries no DOM test environment, and adding
 * one to prove a single call site would be a larger change than the fix. Source
 * assertions cannot prove the handler behaves correctly at runtime; they prove
 * the raw conversion is not present, which is the regression that actually
 * happened.
 *
 * Issue #51 owns the behavioural DOM coverage that would replace this file's
 * guesswork with a rendered modal, and it stays open. Until that dependency and
 * Vitest environment work can be done on a workstation with npm access, the
 * structural block below narrows three of the four blind spots the issue
 * enumerates, still without rendering anything:
 *
 *   - a handler bound to the wrong field, which the plain string checks cannot
 *     see because they never ask which field block they matched inside;
 *   - `disabled={limitsSaveDisabled(limits)}` drifting onto an element that is
 *     not the button which calls `saveLimits`;
 *   - `formatLimitInput` being called with its result discarded.
 *
 * The fourth blind spot — a cleared box whose uncommitted intermediate state
 * leaves Save clickable — is a runtime state question that no source assertion
 * can answer. It stays with issue #51. Nothing here is a substitute for it, and
 * growing this file further would rebuild the false confidence that issue exists
 * to remove.
 */
const source = readFileSync('web/src/admin/main.tsx', 'utf8');

const limitFields = ['dailyBudgetUnits', 'maxConcurrent', 'rateLimitRpm'] as const;

describe('admin limits form conversion', () => {
  it.each(limitFields)('reads %s through parseLimitInput, not Number', (field) => {
    expect(source).toContain(`${field}: parseLimitInput(event.target.value)`);
    expect(source).not.toContain(`${field}: Number(event.target.value)`);
  });

  it.each(limitFields)('renders %s through formatLimitInput so NaN shows an empty box', (field) => {
    expect(source).toContain(`value={formatLimitInput(limits.${field})}`);
  });

  it('imports both helpers rather than declaring local copies', () => {
    expect(source).toContain('parseLimitInput');
    expect(source).toContain('formatLimitInput');
    expect(source).not.toMatch(/function\s+parseLimitInput/);
    expect(source).not.toMatch(/function\s+formatLimitInput/);
  });
});

/**
 * Every structural assertion below is scoped to the limits modal. The plan
 * editor converts its own inputs with `Number(event.target.value)` on purpose,
 * so a file-wide ban on that expression would be wrong while a modal-wide ban is
 * exactly the guard this form needs.
 *
 * Drift throws instead of asserting, so a rename fails the whole file with the
 * marker that moved rather than reporting a misleading per-field failure.
 */
function sliceBetween(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  if (start === -1) {
    throw new Error(`web/src/admin/main.tsx no longer contains "${open}"`);
  }
  const end = text.indexOf(close, start);
  if (end === -1) {
    throw new Error(`web/src/admin/main.tsx has no "${close}" after "${open}"`);
  }
  return text.slice(start, end + close.length);
}

const limitsModal = sliceBetween(source, '<Modal open={limitsFor !== null}', '</Modal>');

function enclosingBlock(open: string, needle: string, close: string): string {
  const at = limitsModal.indexOf(needle);
  if (at === -1) {
    throw new Error(`the limits modal no longer contains "${needle}"`);
  }
  const start = limitsModal.lastIndexOf(open, at);
  if (start === -1) {
    throw new Error(`"${needle}" is no longer inside a "${open}" element`);
  }
  const end = limitsModal.indexOf(close, at);
  if (end === -1) {
    throw new Error(`the "${open}" element holding "${needle}" is not closed`);
  }
  return limitsModal.slice(start, end);
}

function fieldBlock(field: string): string {
  return enclosingBlock('<Field ', `value={formatLimitInput(limits.${field})}`, '</Field>');
}

describe('admin limits modal structure', () => {
  it.each(limitFields)('keeps the %s box bound to its own state key', (field) => {
    const block = fieldBlock(field);
    expect(block).toContain(`${field}: parseLimitInput(event.target.value)`);
    const others = limitFields.filter((candidate) => candidate !== field);
    for (const other of others) {
      expect(block).not.toContain(`limits.${other}`);
      expect(block).not.toContain(`${other}:`);
    }
  });

  it.each([
    ['dailyBudgetUnits', 'DAILY_BUDGET_UNITS'],
    ['maxConcurrent', 'MAX_CONCURRENT'],
    ['rateLimitRpm', 'RATE_LIMIT_RPM']
  ])('bounds the %s box with the shared %s constants', (field, bound) => {
    const block = fieldBlock(field);
    expect(block).toContain('type="number"');
    expect(block).toContain(`min={${bound}.min}`);
    expect(block).toContain(`max={${bound}.max}`);
  });

  it('keeps the raw numeric conversion out of the entire limits modal', () => {
    expect(limitsModal).not.toContain('Number(event.target.value)');
  });

  it('leaves the save guard on the button that calls saveLimits', () => {
    const guard = 'disabled={limitsSaveDisabled(limits)}';
    expect(limitsModal.split(guard)).toHaveLength(2);
    const button = enclosingBlock('<Button', guard, '</Button>');
    expect(button).toContain('onClick={() => void saveLimits()}');
    expect(button).toContain('Save limits');
  });
});
