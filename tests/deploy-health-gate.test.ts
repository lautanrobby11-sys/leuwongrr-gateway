import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deploy = readFileSync('scripts/deploy.sh', 'utf8');
const rollback = readFileSync('scripts/rollback.sh', 'utf8');

function numericConstant(script: string, name: string): number {
  const match = script.match(new RegExp(`readonly ${name}=(\\d+)`));
  if (!match?.[1]) throw new Error(`missing numeric health constant: ${name}`);
  return Number(match[1]);
}

const healthConstants = [
  'HEALTH_REQUEST_TIMEOUT_SECONDS',
  'HEALTH_STARTUP_DEADLINE_SECONDS',
  'HEALTH_RETRY_INTERVAL_SECONDS',
] as const;

describe('deploy and rollback readiness gates', () => {
  it('leaves margin above the application upstream timeout', () => {
    expect(numericConstant(deploy, 'HEALTH_REQUEST_TIMEOUT_SECONDS')).toBeGreaterThan(2);
    expect(numericConstant(deploy, 'HEALTH_STARTUP_DEADLINE_SECONDS')).toBeGreaterThanOrEqual(60);
  });

  it('gives rollback the same recovery budget as a forward deploy', () => {
    for (const name of healthConstants) {
      expect(numericConstant(rollback, name), name).toBe(numericConstant(deploy, name));
    }
    expect(rollback).toContain('--max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS"');
    expect(rollback).toContain('SECONDS + HEALTH_STARTUP_DEADLINE_SECONDS');
    expect(rollback).toContain('sleep "$HEALTH_RETRY_INTERVAL_SECONDS"');
  });

  it('reports safe deploy failure evidence without printing the readiness token', () => {
    expect(deploy).toContain('liveness transport failure rc=');
    expect(deploy).toContain('liveness returned HTTP');
    expect(deploy).toContain('readiness transport failure rc=');
    expect(deploy).toContain('readiness returned HTTP');
    expect(deploy).toContain('health gate exhausted after');
    expect(deploy).not.toMatch(/echo .*INTERNAL_READY_TOKEN/);
  });
});
