import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Directory sweeps, not a hand-maintained list. A list only closes the gaps
 * that exist on the day it is written: `scripts/assert-clean-tree.sh` was
 * absent from the previous list for exactly that reason. Sweeping covers a
 * file added later the moment it lands.
 */
const sweeps = [
  { dir: 'scripts', extensions: ['.sh', '.mjs'] },
  { dir: 'infra/systemd', extensions: ['.service', '.timer'] }
];

const releaseCriticalFiles = sweeps.flatMap(({ dir, extensions }) =>
  readdirSync(dir)
    .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
    .sort()
    .map((entry) => `${dir}/${entry}`)
);

describe('release-critical line endings', () => {
  // A sweep that matched nothing would pass vacuously, so the sweep is asserted
  // before the files are. Every extension below is promised LF by
  // .gitattributes; a glob that silently stops matching is a real regression.
  // Each extension is asserted on its own: a directory-wide check would stay
  // green while one extension quietly stops matching and loses its coverage.
  it.each(sweeps)('$dir yields at least one file per swept extension', ({ dir, extensions }) => {
    for (const extension of extensions) {
      const matched = releaseCriticalFiles.filter(
        (file) => file.startsWith(`${dir}/`) && file.endsWith(extension)
      );
      expect(matched, `no ${extension} file found under ${dir}/`).not.toHaveLength(0);
    }
  });

  it.each(releaseCriticalFiles)('%s contains no carriage returns', (file) => {
    expect(readFileSync(file, 'utf8')).not.toContain('\r');
  });
});
