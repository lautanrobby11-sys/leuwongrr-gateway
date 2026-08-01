import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * markdownlint MD038 rejects a code span padded with spaces inside its
 * backticks. The runbook had four of them, all writing the checksum separator
 * inside the span (`` ` *./path` ``) so the reader could see it. That renders
 * as a span whose content is trimmed anyway, so the detail it was trying to
 * convey never reached the page. The fix shows the marker (`*./path`) inside
 * the span and describes the preceding separator in prose.
 *
 * Asserted over every runbook and ADR so a future doc edit cannot reintroduce
 * the pattern. Fenced blocks are skipped: leading whitespace there is content.
 */
const DOCS = [
  'docs/runbooks/artifact-deploy-bootstrap.md',
  'docs/runbooks/operator-release-authority.md',
  'docs/adr/ADR-012-local-release-authority.md',
  'docs/decisions/ADR-003-quality-gates.md',
  'README.md'
] as const;

function paddedSpans(markdown: string): string[] {
  const offenders: string[] = [];
  let inFence = false;
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const content = match[1];
      if (content.trim() !== '' && content !== content.trim()) {
        offenders.push(`${index + 1}: [${content}]`);
      }
    }
  });
  return offenders;
}

describe('runbook code spans', () => {
  it.each(DOCS)('%s has no space-padded code spans', (path) => {
    expect(paddedSpans(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it('explains the binary-mode marker without hiding it in a padded span', () => {
    const runbook = readFileSync('docs/runbooks/artifact-deploy-bootstrap.md', 'utf8');
    // Both prose passages that justify the awk `sub` must survive.
    const passages = runbook.split('`sub(/^\\*/, ...)`');
    expect(passages).toHaveLength(3);
    for (const marker of ['`*./path`', '`./path`']) {
      expect(runbook).toContain(marker);
    }
    // The separator is described, not embedded: one space before the Windows
    // marker, two before the Linux path.
    expect(runbook).toContain('one space and then `*./path`');
    expect(runbook).toContain('two spaces and then `./path`');
  });

  it('keeps the awk guard the prose describes', () => {
    const runbook = readFileSync('docs/runbooks/artifact-deploy-bootstrap.md', 'utf8');
    expect(runbook).toContain('awk \'{ sub(/^\\*/, "", $2); if ($2 == "./scripts/deploy.sh") print $1 }\'');
    expect(runbook).toContain('awk -v m="$MEMBER" \'{ sub(/^\\*/, "", $2); if ($2 == m) print $1 }\'');
  });
});
