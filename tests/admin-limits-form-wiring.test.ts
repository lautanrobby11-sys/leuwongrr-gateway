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
