import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Two portal findings, both asserted on the source because the login page is a
 * static marketing bundle with no runtime seam to query:
 *
 * 1. The gateway configures a daily budget and meters usage against it. It does
 *    not cap spend in currency, so copy promising cost control ("batasi biaya",
 *    "Budget terkendali") claims enforcement the product does not have. The
 *    honest claim is budget configuration, usage monitoring, and tenant policy.
 * 2. The rendered Python quickstart reads `os.environ`, so it must show
 *    `import os`. A visitor who copies the block verbatim otherwise gets
 *    `NameError: name 'os' is not defined` on their first request.
 */
const portal = readFileSync('web/src/login/main.tsx', 'utf8');

describe('portal copy', () => {
  it('claims no hard budget or cost control', () => {
    for (const claim of ['batasi biaya', 'Budget terkendali', 'batasi budget', 'hemat biaya']) {
      expect({ claim, present: portal.includes(claim) }).toEqual({ claim, present: false });
    }
  });

  it('describes budget as configuration under operator policy', () => {
    expect(portal).toContain('Budget terkonfigurasi');
    expect(portal).toContain('budget harian per tenant mengikuti kebijakan operator');
    expect(portal).toContain('atur budget harian per tenant');
  });

  it('keeps the usage-monitoring claim, which the ledger does support', () => {
    expect(portal).toContain('pantau usage');
    expect(portal).toContain('Usage terukur');
  });

  it('imports os before the quickstart reads os.environ', () => {
    const importOs = portal.indexOf('>import</span> os');
    const environ = portal.indexOf('os.environ[');
    expect(importOs).toBeGreaterThan(-1);
    expect(environ).toBeGreaterThan(importOs);
  });
});
