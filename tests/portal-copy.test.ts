import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Marketing-copy honesty, asserted on the source because the public front door
 * is a static document with no runtime seam to query. The Release 3 overhaul
 * split the old login marketing page in two: the static landing page
 * (web/index.html) carries the marketing copy, and /login became a focused
 * authentication shell. These assertions therefore track the landing page:
 *
 * 1. The gateway configures a daily token budget and meters usage against it.
 *    It does not cap spend in currency, so copy promising cost control ("cut
 *    costs", "cost control", "spend cap") claims enforcement the product does
 *    not have. The honest claim is token budgets, rate limits, and a ledger.
 * 2. The Python quickstart must stay copy-pasteable: the OpenAI import has to
 *    appear before the client call, and the sample must not read an
 *    environment variable it never imports a module for (the old hazard was
 *    `os.environ` without `import os`, a NameError on the first request).
 * 3. The portal went international, so the copy stays English and every
 *    sign-in affordance points at the /login auth shell.
 */
const portal = readFileSync('web/index.html', 'utf8');

describe('portal copy', () => {
  it('claims no hard budget or cost control', () => {
    for (const claim of ['cut costs', 'cost control', 'spend cap', 'cap spend', 'save costs', 'reduce costs']) {
      expect({ claim, present: portal.toLowerCase().includes(claim.toLowerCase()) }).toEqual({ claim, present: false });
    }
  });

  it('describes budgets as token and rate limits, not currency caps', () => {
    expect(portal).toContain('Token budgets');
    expect(portal).toContain('daily unit limits, concurrent-request caps and rate limits per member');
  });

  it('keeps the usage-tracking claim, which the ledger does support', () => {
    expect(portal).toContain('a full ledger');
    expect(portal).toContain('prompts and completions are never logged');
  });

  it('keeps the Python quickstart copy-pasteable', () => {
    const importOpenai = portal.indexOf('from openai import OpenAI');
    const call = portal.indexOf('client.chat.completions.create');
    expect(importOpenai).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(importOpenai);
    // No environment read that the sample never imports: a visitor who copies
    // the block verbatim must not hit a NameError on their first request.
    expect(portal).not.toContain('os.environ');
  });

  it('is written for English readers and points at the auth shell', () => {
    expect(portal).toContain('href="/login"');
    expect(portal).toContain('Sign in');
    expect(portal).not.toContain('Masuk ke console');
  });
});
