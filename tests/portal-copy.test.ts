import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Two portal findings, both asserted on the source because the login page is a
 * static marketing bundle with no runtime seam to query. The copy is English
 * (the portal went international in the Release 2 overhaul), so the assertions
 * track the same two hazards in the new language:
 *
 * 1. The gateway configures a daily budget and meters usage against it. It does
 *    not cap spend in currency, so copy promising cost control ("cut costs",
 *    "cost control", "spend cap") claims enforcement the product does not have.
 *    The honest claim is configured budgets, usage tracking, and tenant policy.
 * 2. The rendered Python quickstart reads `os.environ`, so it must show
 *    `import os`. A visitor who copies the block verbatim otherwise gets
 *    `NameError: name 'os' is not defined` on their first request.
 */
const portal = readFileSync('web/src/login/main.tsx', 'utf8');

describe('portal copy', () => {
  it('claims no hard budget or cost control', () => {
    for (const claim of ['cut costs', 'cost control', 'spend cap', 'cap spend', 'save costs', 'reduce costs']) {
      expect({ claim, present: portal.toLowerCase().includes(claim.toLowerCase()) }).toEqual({ claim, present: false });
    }
  });

  it('describes budgets as configuration under operator policy', () => {
    expect(portal).toContain('Configured budgets');
    expect(portal).toContain('per-tenant daily budgets follow operator policy');
    expect(portal).toContain('set per-tenant daily budgets under operator policy');
  });

  it('keeps the usage-tracking claim, which the ledger does support', () => {
    expect(portal).toContain('track token usage');
    expect(portal).toContain('Measurable usage');
  });

  it('imports os before the quickstart reads os.environ', () => {
    const importOs = portal.indexOf('>import</span> os');
    const environ = portal.indexOf('os.environ[');
    expect(importOs).toBeGreaterThan(-1);
    expect(environ).toBeGreaterThan(importOs);
  });

  it('is written for English readers', () => {
    // The old Indonesian portal had an anchor that no longer exists; the new
    // nav and sign-in card target #signin.
    expect(portal).toContain('href="#signin"');
    expect(portal).toContain('Sign in to the console');
    expect(portal).not.toContain('Masuk ke console');
  });
});
