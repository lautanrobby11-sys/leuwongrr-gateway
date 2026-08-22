import { describe, expect, it } from 'vitest';
import { parseBulkModels } from './bulk-models';

/**
 * The bulk parser is the contract between the paste box and the payload: the
 * preview an operator approves must be exactly what the server receives, so a
 * field that fails the single-editor bounds becomes a per-line issue rather
 * than a silently-shipped bad value.
 */
describe('parseBulkModels', () => {
  it('parses fields in order and leaves - and blanks unchanged', () => {
    const { rows, issues } = parseBulkModels('gpt-5, 125, 1000, 12.5, true, value, gpt-5');
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        id: 'gpt-5',
        inputPriceCents: 125,
        outputPriceCents: 1000,
        cacheReadPriceCents: 12.5,
        enabled: true,
        groupId: 'value',
        upstreamModel: 'gpt-5'
      }
    ]);
  });

  it('skips comments and blank lines, and accepts pipe separators', () => {
    const { rows } = parseBulkModels('# header\n\nclaude-opus | - | 7500 | - | false');
    expect(rows).toEqual([{ id: 'claude-opus', outputPriceCents: 7500, enabled: false }]);
  });

  it('reports a bad id, an out-of-range price, and a non-boolean without dropping good rows', () => {
    const { rows, issues } = parseBulkModels(
      ['GOOD-model, 10', 'legit-a, 2000000', 'legit-b, -, -, -, maybe', 'legit-c, 50'].join('\n')
    );
    expect(rows).toEqual([{ id: 'legit-c', inputPriceCents: 50 }]);
    expect(issues.map((issue) => issue.line)).toEqual([1, 2, 3]);
  });

  it('rejects a row that names an id but changes nothing', () => {
    const { rows, issues } = parseBulkModels('lonely-id');
    expect(rows).toEqual([]);
    expect(issues[0]?.reason).toContain('No fields to change');
  });

  it('flags a trailing separator whose fields all mean "unchanged"', () => {
    // `gpt-5,` parses to a bare id: the server would answer 400 for it, so the
    // preview must reject it before Apply can be offered.
    const { rows, issues } = parseBulkModels('gpt-5,');
    expect(rows).toEqual([]);
    expect(issues[0]?.reason).toContain('every field after the id is "-" or empty');
  });

  it('flags a line with more fields than the format defines', () => {
    const { rows, issues } = parseBulkModels('good-model, 1, 2, 3, true, value, up, EXTRA');
    expect(rows).toEqual([]);
    expect(issues[0]?.reason).toContain('Too many fields (8)');
  });
});
