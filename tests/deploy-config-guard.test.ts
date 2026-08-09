import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploy = readFileSync('scripts/deploy.sh', 'utf8');

function resolveBash(): string {
  if (process.platform === 'darwin') return '/bin/bash';
  if (process.platform !== 'win32') return '/usr/bin/bash';
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  return join(gitExecPath, '..', '..', '..', 'usr', 'bin', 'bash.exe');
}

describe('production configuration deploy guard', () => {
  it.each([
    ['unquoted', 'OMNIROUTE_API_KEY=REPLACE_ME'],
    ['single-quoted', "OMNIROUTE_API_KEY='REPLACE_ME'"],
    ['double-quoted', 'OMNIROUTE_API_KEY="REPLACE_ME"'],
  ])('rejects active placeholder in %s form before release-side actions', (_form, placeholderLine) => {
    const root = mkdtempSync(join(tmpdir(), 'lwrr-deploy-config-'));
    try {
      const envFile = join(root, 'gateway.env');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        envFile,
        [
          'GATEWAY_HOST=127.0.0.1',
          'GATEWAY_PORT=2080',
          'OMNIROUTE_URL=http://127.0.0.1:20128',
          'DATABASE_PATH=/opt/leuwongrr-gateway/data/gateway.db',
          placeholderLine,
          `API_KEY_PEPPER=${'p'.repeat(32)}`,
          `INTERNAL_READY_TOKEN=${'r'.repeat(32)}`,
          'CONSOLE_ENABLED=false'
        ].join('\n') + '\n'
      );
      const statStub = join(bin, 'stat');
      writeFileSync(
        statStub,
        '#!/usr/bin/env bash\ncase "$2" in\n  %a) printf "600\\n" ;;\n  %U:%G) printf "root:root\\n" ;;\n  *) exit 1 ;;\nesac\n'
      );
      chmodSync(statStub, 0o755);

      const result = spawnSync(
        resolveBash(),
        ['-c', 'source scripts/deploy.sh; validate_production_config "$1"', '_', envFile],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
        }
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toMatch(/placeholder/i);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/release directory|npm ci|preflight|systemctl/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the configuration guard before release creation, install, preflight, activation, and health', () => {
    const main = deploy.indexOf('[[ $EUID -eq 0 ]]');
    const guard = deploy.indexOf('validate_production_config "$ENV_FILE"', main);
    expect(main).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(main);
    for (const action of [
      'mkdir -m 0750 "$RELEASE"',
      'install_production_dependencies "$RELEASE"',
      'run_preflight "$RELEASE"',
      'mv -Tf "$CANDIDATE_LINK" "$ROOT/current"',
      'systemctl restart "$SERVICE"',
      'wait_for_health'
    ]) {
      expect(guard).toBeLessThan(deploy.indexOf(action, main));
    }
  });
});
