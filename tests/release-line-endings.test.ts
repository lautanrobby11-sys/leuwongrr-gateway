import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const releaseCriticalFiles = [
  'scripts/deploy.sh',
  'scripts/rollback.sh',
  'scripts/backup.sh',
  'scripts/restore-drill.sh',
  'scripts/ping-snapshot-healthcheck.sh',
  'scripts/vps-bootstrap.sh',
  'infra/systemd/leuwongrr-gateway.service',
  'infra/systemd/leuwongrr-gateway-snapshot.service',
  'infra/systemd/leuwongrr-gateway-snapshot.timer'
];

describe('release-critical line endings', () => {
  it.each(releaseCriticalFiles)('%s contains no carriage returns', (file) => {
    expect(readFileSync(file, 'utf8')).not.toContain('\r');
  });
});
