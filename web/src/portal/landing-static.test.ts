import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The landing page is a deliberately static document (no React bundle on the
 * public front door), so its behaviour is asserted against the source HTML:
 * the promise, copyable quickstarts, honest pricing, favicon and SEO metadata.
 */
const landing = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');

describe('static landing page', () => {
  it('presents the hero, both quickstart copies and the plan shapes', () => {
    expect(landing).toContain('One gateway for every model your team uses.');
    expect(landing.match(/data-copy="/g)?.length).toBe(2);
    expect(landing).toContain('https://api.leuwongrr.cloud/v1/chat/completions');
    expect(landing).toContain('rolling plans');
    expect(landing).toContain('token packs');
    expect(landing).toContain('href="/login"');
  });

  it('stays honest about pricing', () => {
    // No fabricated numbers: live prices come from the signed-in catalog.
    expect(landing).not.toMatch(/\$ ?\d/);
    expect(landing).toContain('shown after sign-in');
  });

  it('wears the favicon and stays indexable', () => {
    expect(landing).toContain('/console/assets/favicon.svg');
    expect(landing).toContain('index, follow');
    expect(landing).toContain('LeuwongRR Gateway · Private AI API for Teams');
  });

  it('declares a canonical URL and structured data', () => {
    expect(landing).toContain('<link rel="canonical" href="https://api.leuwongrr.cloud/" />');
    expect(landing).toContain('application/ld+json');
    expect(landing).toContain('"@type":"WebSite"');
  });
});
