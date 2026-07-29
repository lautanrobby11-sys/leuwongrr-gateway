import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deploy = readFileSync('scripts/deploy.sh', 'utf8');

function numericConstant(name: string): number {
  const match = deploy.match(new RegExp(`readonly ${name}=(\\d+)`));
  if (!match?.[1]) throw new Error(`missing numeric deploy constant: ${name}`);
  return Number(match[1]);
}

describe('deploy readiness gate', () => {
  it('leaves margin above the application upstream timeout', () => {
    // READY_UPSTREAM_TIMEOUT_MS defaults to 2000 ms in src/config.ts. The
    // outer curl must live longer so it can receive the application's 503
    // instead of racing and reporting an opaque transport timeout.
    expect(numericConstant('HEALTH_REQUEST_TIMEOUT_SECONDS')).toBeGreaterThan(2);
    expect(numericConstant('HEALTH_STARTUP_DEADLINE_SECONDS')).toBeGreaterThanOrEqual(60);
  });

  it('reports safe failure evidence without printing the readiness token', () => {
    expect(deploy).toContain('liveness transport failure rc=');
    expect(deploy).toContain('liveness returned HTTP');
    expect(deploy).toContain('readiness transport failure rc=');
    expect(deploy).toContain('readiness returned HTTP');
    expect(deploy).toContain('health gate exhausted after');
    expect(deploy).not.toMatch(/echo .*INTERNAL_READY_TOKEN/);
  });
});
