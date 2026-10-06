import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  TOOLS,
  classifySources,
  countLines,
  failures,
  largestClones,
  makeClone,
  newClones,
  parseArguments,
  parseBudget,
  parseCpdReport,
  parseFallowReport,
  parseJscpdReport,
  parseScanSettings,
  percentage,
  renderSummary,
} from '../scripts/duplication-core.js';
import type { Clone, Measurement } from '../scripts/duplication-core.js';

const TREE = join('/', 'work', 'tree');

function measurement(percentageValue: number, duplicatedLines: number, clones: readonly Clone[] = []): Measurement {
  return { percentage: percentageValue, duplicatedLines, totalLines: 1000, clones };
}

function clone(file: string, start: number, end: number, other = `${file}.copy`): Clone {
  return makeClone(TREE, [
    { file, start, end },
    { file: other, start, end },
  ]);
}

describe('parseArguments', () => {
  it('runs every tool when none is named', () => {
    expect(parseArguments([])).toEqual({ tools: TOOLS, base: undefined });
  });

  it('keeps the named tools in order, once each, and the base ref', () => {
    expect(parseArguments(['fallow', '--base', 'origin/main', 'jscpd', 'fallow'])).toEqual({
      tools: ['fallow', 'jscpd'],
      base: 'origin/main',
    });
  });

  it.each([
    [['--base'], '--base needs a git ref'],
    [['--base', ''], '--base needs a git ref'],
    [['--base', '--other'], '--base needs a git ref'],
    [['--base', 'a', '--base', 'b'], '--base given twice'],
    [['simian'], 'unknown argument "simian"'],
    [['--help'], 'unknown argument "--help"'],
  ])('rejects %j', (args, message) => {
    expect(() => parseArguments(args)).toThrow(message);
  });
});

describe('parseBudget', () => {
  it('reads one maximum per tool', () => {
    expect(parseBudget({ maxPercentage: { jscpd: 1.07, cpd: 3.47, fallow: 0 } })).toEqual({
      maxPercentage: { jscpd: 1.07, cpd: 3.47, fallow: 0 },
    });
  });

  it.each([
    [null, 'duplication-budget.json is not an object'],
    [[], 'duplication-budget.json is not an object'],
    [{}, 'maxPercentage is not an object'],
    [{ maxPercentage: { jscpd: 1, cpd: 1 } }, 'maxPercentage.fallow is not a finite number'],
    [{ maxPercentage: { jscpd: '1', cpd: 1, fallow: 1 } }, 'maxPercentage.jscpd is not a finite number'],
    [{ maxPercentage: { jscpd: 1, cpd: -0.5, fallow: 1 } }, 'maxPercentage.cpd is outside 0–100'],
    [{ maxPercentage: { jscpd: 1, cpd: 1, fallow: 101 } }, 'maxPercentage.fallow is outside 0–100'],
    [{ maxPercentage: { jscpd: 1, cpd: 1, fallow: 1, simian: 1 } }, 'unknown tools: simian'],
  ])('rejects %j', (json, message) => {
    expect(() => parseBudget(json)).toThrow(message);
  });

  it('treats __proto__ as an unknown tool rather than a prototype', () => {
    const json: unknown = JSON.parse('{"maxPercentage":{"__proto__":{"jscpd":1},"cpd":1,"fallow":1}}');
    expect(() => parseBudget(json)).toThrow('unknown tools: __proto__');
  });

  it('does not read a maximum inherited from the prototype', () => {
    const json: unknown = JSON.parse('{"maxPercentage":{"cpd":1,"fallow":1}}');
    Object.defineProperty(Object.prototype, 'jscpd', { value: 1, configurable: true });
    try {
      expect(() => parseBudget(json)).toThrow('maxPercentage.jscpd is not a finite number');
    } finally {
      Reflect.deleteProperty(Object.prototype, 'jscpd');
    }
  });
});

describe('parseScanSettings', () => {
  it('reads the paths and minimum token count, ignoring the other jscpd settings', () => {
    expect(parseScanSettings({ path: ['src', 'bin'], minTokens: 50, mode: 'mild' })).toEqual({
      paths: ['src', 'bin'],
      minTokens: 50,
    });
  });

  it.each([
    [{ minTokens: 50 }, 'path is not an array'],
    [{ path: [], minTokens: 50 }, 'path is empty'],
    [{ path: [''], minTokens: 50 }, 'path[0] is not a non-empty string'],
    [{ path: ['/etc'], minTokens: 50 }, 'must stay inside the repository'],
    [{ path: ['src', '../other'], minTokens: 50 }, 'path[1] must stay inside the repository'],
    [{ path: ['src'] }, 'minTokens is not a finite number'],
    [{ path: ['src'], minTokens: 0 }, 'minTokens is not a positive integer'],
    [{ path: ['src'], minTokens: 2.5 }, 'minTokens is not a positive integer'],
  ])('rejects %j', (json, message) => {
    expect(() => parseScanSettings(json)).toThrow(message);
  });
});

describe('makeClone', () => {
  it('makes paths relative to the tree and adds up the lines of all instances', () => {
    const c = makeClone(TREE, [
      { file: join(TREE, 'src', 'b.ts'), start: 10, end: 19 },
      { file: 'src/a.ts', start: 1, end: 12 },
    ]);
    expect(c.lines).toBe(22);
    expect(c.locations).toEqual(['src/b.ts:10-19', 'src/a.ts:1-12']);
  });

  it('identifies a clone by its files and sizes, not by where it starts', () => {
    const before = makeClone(TREE, [
      { file: 'src/a.ts', start: 1, end: 10 },
      { file: 'src/b.ts', start: 40, end: 49 },
    ]);
    const moved = makeClone(TREE, [
      { file: 'src/b.ts', start: 52, end: 61 },
      { file: 'src/a.ts', start: 3, end: 12 },
    ]);
    const grown = makeClone(TREE, [
      { file: 'src/a.ts', start: 1, end: 11 },
      { file: 'src/b.ts', start: 40, end: 50 },
    ]);
    expect(moved.key).toBe(before.key);
    expect(grown.key).not.toBe(before.key);
  });
});

describe('parseJscpdReport', () => {
  const report = {
    statistics: {
      total: { clones: 1, duplicatedLines: 20, lines: 400, percentage: 5, sources: 2, tokens: 3000 },
      formats: {},
    },
    duplicates: [
      {
        format: 'typescript',
        lines: 10,
        tokens: 80,
        firstFile: { name: join(TREE, 'src', 'a.ts'), start: 5, end: 14, startLoc: {}, endLoc: {} },
        secondFile: { name: join(TREE, 'src', 'b.ts'), start: 30, end: 39, startLoc: {}, endLoc: {} },
      },
    ],
  };

  it('takes the totals from jscpd and one clone per duplicate', () => {
    expect(parseJscpdReport(report, TREE)).toEqual({
      percentage: 5,
      duplicatedLines: 20,
      totalLines: 400,
      clones: [
        makeClone(TREE, [
          { file: 'src/a.ts', start: 5, end: 14 },
          { file: 'src/b.ts', start: 30, end: 39 },
        ]),
      ],
    });
  });

  it('names the field that is wrong', () => {
    expect(() => parseJscpdReport({ duplicates: [] }, TREE)).toThrow('jscpd report: statistics is not an object');
    const noEnd = structuredClone(report);
    Reflect.deleteProperty(noEnd.duplicates[0]?.secondFile ?? {}, 'end');
    expect(() => parseJscpdReport(noEnd, TREE)).toThrow(
      'jscpd report: duplicates[0].secondFile.end is not a finite number',
    );
    const backwards = structuredClone(report);
    const first = backwards.duplicates[0]?.firstFile;
    if (first) first.end = 4;
    expect(() => parseJscpdReport(backwards, TREE)).toThrow('ends (line 4) before it starts (line 5)');
  });
});

describe('parseFallowReport', () => {
  const report = {
    kind: 'dupes',
    stats: { duplication_percentage: 2.5, duplicated_lines: 30, total_lines: 1200 },
    clone_groups: [
      {
        instances: [
          { file: 'src/a.ts', start_line: 1, end_line: 10 },
          { file: 'src/b.ts', start_line: 21, end_line: 30 },
          { file: 'src/c.ts', start_line: 41, end_line: 50 },
        ],
        fingerprint: 'dup:0123456789abcdef',
      },
    ],
  };

  it('takes the totals from fallow and one clone per group, with every instance', () => {
    const m = parseFallowReport(report, TREE);
    expect(m).toMatchObject({ percentage: 2.5, duplicatedLines: 30, totalLines: 1200 });
    expect(m.clones).toHaveLength(1);
    expect(m.clones[0]?.locations).toEqual(['src/a.ts:1-10', 'src/b.ts:21-30', 'src/c.ts:41-50']);
    expect(m.clones[0]?.lines).toBe(30);
  });

  it('rejects a group with a single instance and a malformed line number', () => {
    const single = structuredClone(report);
    single.clone_groups[0]?.instances.splice(1);
    expect(() => parseFallowReport(single, TREE)).toThrow('clone_groups[0] has fewer than two instances');
    const zero = structuredClone(report);
    const instance = zero.clone_groups[0]?.instances[1];
    if (instance) instance.start_line = 0;
    expect(() => parseFallowReport(zero, TREE)).toThrow('instances[1].start_line is not a line number: 0');
  });

  it('rejects output that is not a dupes report', () => {
    expect(() => parseFallowReport({ error: 'config' }, TREE)).toThrow('fallow report: stats is not an object');
  });
});

describe('parseCpdReport', () => {
  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<pmd-cpd xmlns="https://pmd-code.org/schema/cpd-report" pmdVersion="7.28.0" version="1.0.0">\n';
  const file = (path: string, line: number, endline: number): string =>
    `<file begintoken="1" column="1" endcolumn="2" endline="${endline}" endtoken="9" line="${line}"\n path="${path}"/>`;
  const a = join(TREE, 'src', 'a.ts');
  const b = join(TREE, 'src', 'b&c.ts');
  const xml =
    header +
    `<file path="${a}" totalNumberOfTokens="500"/>\n` +
    `<file path="${b.replace('&', '&amp;')}" totalNumberOfTokens="400"/>\n` +
    `<duplication lines="10" tokens="60">\n${file(a, 1, 10)}\n${file(b.replace('&', '&amp;'), 21, 30)}\n` +
    // Fragments are code; markup in them must not be read as instances
    '<codefragment><![CDATA[const s = \'<file path="x.ts" line="1" endline="2"/></duplication>\';]]></codefragment>\n' +
    '</duplication>\n' +
    // Overlaps the first clone in a.ts: lines 6–10 count once
    `<duplication lines="10" tokens="55">\n${file(a, 6, 15)}\n${file(a, 40, 49)}\n</duplication>\n` +
    '</pmd-cpd>\n';

  it('lists the analyzed files and counts each duplicated line once', () => {
    const report = parseCpdReport(xml, TREE);
    expect(report.analyzedFiles).toEqual([a, b]);
    expect(report.clones.map((c) => c.locations)).toEqual([
      ['src/a.ts:1-10', 'src/b&c.ts:21-30'],
      ['src/a.ts:6-15', 'src/a.ts:40-49'],
    ]);
    // a.ts: 1–15 and 40–49; b&c.ts: 21–30
    expect(report.duplicatedLines).toBe(15 + 10 + 10);
  });

  it('reads attributes in any order and numeric character references', () => {
    const report = parseCpdReport(
      `${header}<duplication lines="2"><file path="src/x&#46;ts" endline="7" line="3"/>` +
        `<file line="9" endline="13" path="src/y&#x2E;ts"/></duplication></pmd-cpd>`,
      TREE,
    );
    expect(report.clones[0]?.locations).toEqual(['src/x.ts:3-7', 'src/y.ts:9-13']);
  });

  it('refuses a report with processing errors', () => {
    expect(() =>
      parseCpdReport(`${header}<error filename="src/a.ts" msg="Lexical error at line 3"/></pmd-cpd>`, TREE),
    ).toThrow('CPD report lists processing errors:\nsrc/a.ts: Lexical error at line 3');
  });

  it.each([
    ['', 'CPD report has no <pmd-cpd> element'],
    [`${header}<duplication><file path="a.ts" line="1" endline="2"/></duplication></pmd-cpd>`, 'fewer than two'],
    [`${header}<duplication><file path="a.ts" line="1"/><file path="b.ts" line="1"/></duplication>`, 'no endline'],
    [`${header}<file path="a&nbsp;.ts"/></pmd-cpd>`, 'unknown XML entity &nbsp;'],
    [`${header}<file totalNumberOfTokens="3"/></pmd-cpd>`, 'CPD report: <file> has no path attribute'],
  ])('rejects malformed output %#', (text, message) => {
    expect(() => parseCpdReport(text, TREE)).toThrow(message);
  });
});

describe('countLines', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\n\n', 2],
    ['\n', 1],
  ])('%j has %i lines', (text, lines) => {
    expect(countLines(text)).toBe(lines);
  });
});

describe('percentage', () => {
  it('is zero for an empty tree', () => {
    expect(percentage(0, 0)).toBe(0);
    expect(percentage(25, 200)).toBe(12.5);
  });
});

describe('classifySources', () => {
  it('keeps .ts files and flags other script files that CPD would skip', () => {
    expect(
      classifySources(['src/a.ts', 'src/b.d.ts', 'src/c.tsx', 'src/d.mts', 'src/e.js', 'src/f.json', 'src/g.cjs']),
    ).toEqual({
      typescript: ['src/a.ts', 'src/b.d.ts'],
      unsupported: ['src/c.tsx', 'src/d.mts', 'src/e.js', 'src/g.cjs'],
    });
  });
});

describe('failures', () => {
  const base = (m: Measurement) => ({ ref: 'main', measurement: m });

  it('passes at or under the budget', () => {
    expect(failures(2, measurement(2, 20), undefined)).toEqual([]);
  });

  it('fails over the budget', () => {
    expect(failures(2, measurement(2.004, 20), undefined)).toEqual(['duplication 2.00% exceeds the budget of 2.00%']);
  });

  it('fails when a change adds duplicated lines and raises the share', () => {
    expect(failures(5, measurement(1.5, 15), base(measurement(1, 10)))).toEqual([
      'duplication grew from 1.00% to 1.50% (10 → 15 duplicated lines) compared with main',
    ]);
  });

  it.each([
    ['adds lines but lowers the share', measurement(0.9, 12)],
    ['raises the share by removing other code', measurement(1.2, 10)],
    ['removes duplication', measurement(0.5, 5)],
    ['leaves it unchanged', measurement(1, 10)],
  ])('passes a change that %s', (_, head) => {
    expect(failures(5, head, base(measurement(1, 10)))).toEqual([]);
  });

  it('reports both reasons together', () => {
    expect(failures(1, measurement(1.5, 15), base(measurement(1, 10)))).toHaveLength(2);
  });
});

describe('newClones and largestClones', () => {
  const kept = clone('src/a.ts', 1, 10);
  const added = clone('src/b.ts', 1, 30);
  const small = clone('src/c.ts', 1, 5);

  it('lists the clones the base does not have, even when they moved', () => {
    const moved = clone('src/a.ts', 11, 20);
    expect(newClones(measurement(0, 0, [moved, added]), measurement(0, 0, [kept]))).toEqual([added]);
  });

  it('sorts by size, largest first', () => {
    expect(largestClones(measurement(0, 0, [kept, small, added]))).toEqual([added, kept, small]);
  });
});

describe('renderSummary', () => {
  it('shows the head alone without a base', () => {
    const text = renderSummary('jscpd', 2, measurement(1.234, 12, [clone('src/a.ts', 1, 6)]), undefined, []);
    expect(text).toContain('## Duplication: jscpd');
    expect(text).toContain('| this tree | 1.23% | 12 / 1000 | 1 |');
    expect(text).not.toContain('base');
    expect(text).toContain('Budget: 2.00% (duplication-budget.json).');
    expect(text).toContain('### Largest clones\n\n- 12 lines: `src/a.ts:1-6`, `src/a.ts.copy:1-6`');
    expect(text).not.toContain('### Failed');
  });

  it('compares with a base, shortening a commit hash, and lists new clones and failures', () => {
    const old = clone('src/a.ts', 1, 6);
    const fresh = clone('src/b.ts', 1, 10);
    const text = renderSummary(
      'cpd',
      2,
      measurement(1.5, 32, [old, fresh]),
      { ref: 'a'.repeat(40), measurement: measurement(2, 12, [old]) },
      ['too much'],
    );
    expect(text).toContain('| base aaaaaaa | 2.00% | 12 / 1000 | 1 |');
    expect(text).toContain('| change | −0.50% | +20 | +1 |');
    expect(text).toContain('### New clones\n\n- 20 lines: `src/b.ts:1-10`');
    expect(text).toContain('### Failed\n\n- too much');
  });

  it('keeps a branch name as it is and lists at most 15 clones', () => {
    const many = Array.from({ length: 17 }, (_, i) => clone(`src/f${i}.ts`, 1, 5));
    const text = renderSummary(
      'fallow',
      2,
      measurement(1, 10, many),
      { ref: 'origin/main', measurement: measurement(1, 10, many) },
      [],
    );
    expect(text).toContain('| base origin/main |');
    expect(text).toContain('| change | ±0.00% | ±0 | ±0 |');
    expect(text).not.toContain('### New clones');
    expect(text).toContain('- … and 2 more');
  });
});
