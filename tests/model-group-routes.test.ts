import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, jsonResponse, type Harness } from './support/harness.js';

let harness: Harness | null = null;
let distRoot: string | null = null;
afterEach(async () => { if (harness) { await harness.cleanup(); harness = null; } if (distRoot) { rmSync(distRoot, { recursive: true, force: true }); distRoot = null; } });
function start(): Harness {
  distRoot = mkdtempSync(join(tmpdir(), 'lwrr-group-routes-'));
  mkdirSync(join(distRoot, 'assets'));
  writeFileSync(join(distRoot, 'admin.html'), '<!doctype html>', 'utf8');
  harness = createHarness(jsonResponse, { CONSOLE_ENABLED: true, WEB_DIST_PATH: distRoot });
  return harness;
}

describe('model group admin routes', () => {
  it('creates and lists model groups through the admin surface', async () => {
    const active = start();
    const headers = { 'cf-access-jwt-assertion': 'valid', origin: 'http://127.0.0.1:2080' };
    const created = await active.app.inject({ method: 'POST', url: '/console/api/admin/model-groups', headers, payload: { id: 'value', name: 'Value', multiplierBps: 12500, enabled: true } });
    expect(created.statusCode).toBe(503);
    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/model-groups', headers });
    expect(listed.statusCode).toBe(503);
  });
});
