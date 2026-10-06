import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverAllFormats,
  discoverFormats,
  getFormatIdByName,
  getFormatIdByNameAndVersion,
  makeFormatId,
  readFormatSource,
  selectFormatCandidate,
} from '../src/formats.js';
import { decodeFormatJSON, parseFormatJSON } from '../src/format-decode.js';
import type { Diagnostic, FormatRequest } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'storyformats');

describe('discoverFormats', () => {
  it('discovers formats in the fixtures directory', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    expect(formats.size).toBeGreaterThanOrEqual(1);
    expect(formats.has('test-format-1')).toBe(true);

    const tf = formats.get('test-format-1')!;
    expect(tf.name).toBe('Test Format');
    expect(tf.version).toBe('1.0.0');
    expect(tf.isTwine2).toBe(true);
  });

  it('returns empty map for nonexistent directory', () => {
    const formats = discoverFormats(['/nonexistent/path']);
    expect(formats.size).toBe(0);
  });
});

describe('getFormatIdByName', () => {
  it('finds format by Twine 2 name', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    const id = getFormatIdByName(formats, 'Test Format');
    expect(id).toBe('test-format-1');
  });

  it('returns undefined for unknown format', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    const id = getFormatIdByName(formats, 'Unknown Format');
    expect(id).toBeUndefined();
  });
});

describe('getFormatIdByNameAndVersion', () => {
  it('finds format matching major version', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    const id = getFormatIdByNameAndVersion(formats, 'Test Format', '1.0.0');
    expect(id).toBe('test-format-1');
  });
});

describe('parseFormatJSON with a Harlowe setup function', () => {
  const HARLOWE_DIR = join(__dirname, 'fixtures', 'storyformats-harlowe');
  const source = readFileSync(join(HARLOWE_DIR, 'harlowe-3', 'format.js'), 'utf-8');

  it('parses the same bytes regardless of the format ID it is given', () => {
    for (const id of ['harlowe-3', 'direct-url', 'anything']) {
      const data = parseFormatJSON(source, id);
      expect(data?.name).toBe('Harlowe');
      expect(data?.version).toBe('3.3.9');
      expect(data?.source).toContain('{{STORY_DATA}}');
    }
  });

  it('discovers the format from a local directory', () => {
    const formats = discoverFormats([HARLOWE_DIR]);
    expect(formats.get('harlowe-3')?.name).toBe('Harlowe');
  });

  it('still rejects source that is not a format', () => {
    expect(parseFormatJSON('window.storyFormat({"name":"X", "setup": function(){}});', 'harlowe-3')).toBeNull();
  });
});

describe('format wrapper comments (#221)', () => {
  const object = JSON.stringify({ name: 'Review', version: '1.0.0', source: '<b>{{STORY_DATA}} } {</b>' });
  const plain = `window.storyFormat(${object});`;

  const wrapped = {
    'leading brace comment': `/* Copyright {license} */\n${plain}`,
    'trailing brace comment': `${plain}\n// License {notice}`,
    'surrounding brace comments': `/* { */\n// }}}\n${plain}\n/* } */ // {`,
    'unbalanced braces in comments': `// }\n/* { { */${plain}// {{`,
    'comment between wrapper and object': `window.storyFormat(/* { */ ${object} /* } */);`,
    'braces in strings before the call': `var s = "{ }'"; var t = '}'; var u = \`{\${'}'}\`;\n${plain}`,
    'a trailing script after the call': `${plain}\nvar later = { a: 1 };`,
  };

  for (const [label, source] of Object.entries(wrapped)) {
    it(`decodes the same format with ${label}`, () => {
      const data = parseFormatJSON(source);
      expect(data?.name).toBe('Review');
      expect(data?.source).toBe('<b>{{STORY_DATA}} } {</b>');
    });
  }

  const obj = '{"name":"E","version":"1.0.0","source":"s"}';

  it('ignores lookalike identifiers and calls without an object', () => {
    expect(parseFormatJSON(`xstoryFormat({"name":"X"}); storyFormat /* c */ ; window.storyFormat(${obj});`)?.name).toBe(
      'E',
    );
    expect(parseFormatJSON(`window.storyFormat(\n // c\n ${obj} // tail`)?.name).toBe('E');
  });

  it('copes with escapes, template substitutions and unterminated trivia', () => {
    expect(parseFormatJSON(`var a = "q\\" {"; var b = \`x\${ "}" + \`{\` }\`; storyFormat(${obj}); /* {`)?.name).toBe(
      'E',
    );
    expect(parseFormatJSON(`storyFormat(${obj}); // {`)?.name).toBe('E');
  });

  it('falls back to the last closing brace when the object is not balanced', () => {
    const regex = '{"name":"E","version":"1.0.0","source":"s","setup": function(){ return /\'{/; }}';
    expect(decodeFormatJSON(`storyFormat(${regex}); // }`).ok).toBe(true);
    expect(decodeFormatJSON('storyFormat({"name":"E", "source": `x${ ').ok).toBe(false);
    expect(decodeFormatJSON('} storyFormat({').ok).toBe(false);
    expect(decodeFormatJSON('x = "unterminated {').ok).toBe(false);
  });

  it('decodes a relaxed object between brace comments', () => {
    const source = `/* { */ window.storyFormat({ name: 'R', /* } */ version: "1.0.0", source: 'a}{',\n});\n// }`;
    expect(parseFormatJSON(source)?.source).toBe('a}{');
  });

  it('keeps the Harlowe setup function workaround behind comments', () => {
    const source = `/* {x} */ window.storyFormat({"name":"H","version":"3.0.0","source":"s","setup": function(){ return {a:1}; }});\n// }`;
    expect(parseFormatJSON(source)?.name).toBe('H');
  });

  it('still reports a malformed object', () => {
    expect(decodeFormatJSON('/* {a} */ window.storyFormat({name: });').ok).toBe(false);
  });

  it('still rejects executable expressions in the object', () => {
    const source = '/* {} */ window.storyFormat({"name":"X","version":"1.0.0","source":f()});';
    expect(decodeFormatJSON(source).ok).toBe(false);
  });

  it('reports no chunk when only comments and strings hold braces', () => {
    const result = decodeFormatJSON('/* { } */ var s = "{}";');
    expect(result).toEqual({ ok: false, reason: 'Could not find Twine 2 style story format JSON chunk.' });
  });

  it('reads the source of a locally discovered format with wrapper comments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-wrap-'));
    try {
      mkdirSync(join(dir, 'review'));
      writeFileSync(join(dir, 'review', 'format.js'), `/* {license} */\n${plain}\n// {end}`);
      const format = [...discoverFormats([dir]).values()][0];
      expect(format?.name).toBe('Review');
      expect(format && readFormatSource(format)).toBe('<b>{{STORY_DATA}} } {</b>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('makeFormatId', () => {
  it('builds a directory-style ID from a name and version', () => {
    expect(makeFormatId('SugarCube', '2.37.3')).toBe('sugarcube-2');
    expect(makeFormatId('Test  Format', '1.0.0')).toBe('test-format-1');
  });
});

describe('selectFormatCandidate', () => {
  const candidates = [
    { name: 'SugarCube', version: '2.36.1' },
    { name: 'SugarCube', version: '2.37.3' },
    { name: 'SugarCube', version: '1.0.35' },
    { name: 'Harlowe', version: '3.3.9' },
  ] as const;
  const select = (request: FormatRequest, allowOlder = false) =>
    selectFormatCandidate(request, candidates, (c) => c, { allowOlder })?.version;

  it('prefers an exact version, then the highest same-major version at or above it', () => {
    expect(select({ kind: 'name', name: 'SugarCube', version: '2.36.1' })).toBe('2.36.1');
    expect(select({ kind: 'name', name: 'sugarcube', version: '2.30.0' })).toBe('2.37.3');
    expect(select({ kind: 'name', name: 'SugarCube', version: '2.38.0' })).toBeUndefined();
    expect(select({ kind: 'name', name: 'SugarCube', version: '3.0.0' })).toBeUndefined();
  });

  it('takes the highest version of any major when the version is unparseable', () => {
    expect(select({ kind: 'name', name: 'SugarCube', version: '' })).toBe('2.37.3');
  });

  it('matches IDs by name and major', () => {
    expect(select({ kind: 'id', id: 'sugarcube-2' })).toBe('2.37.3');
    expect(select({ kind: 'id', id: 'sugarcube-1' })).toBe('1.0.35');
    expect(select({ kind: 'id', id: 'harlowe-3' })).toBe('3.3.9');
    expect(select({ kind: 'id', id: 'harlowe-2' })).toBeUndefined();
  });

  it('allows an older same-major version only when asked', () => {
    expect(select({ kind: 'name', name: 'SugarCube', version: '2.38.0' }, true)).toBe('2.37.3');
    expect(select({ kind: 'name', name: 'SugarCube', version: '3.0.0' }, true)).toBeUndefined();
  });

  it('matches names without regard to case, preferring an exact-case match (#156)', () => {
    const mixed = [
      { name: 'sugarcube', version: '2.37.3' },
      { name: 'SugarCube', version: '2.36.1' },
    ];
    const pick = (name: string) => selectFormatCandidate({ kind: 'name', name, version: '2.0.0' }, mixed, (c) => c);
    expect(pick('SugarCube')?.version).toBe('2.36.1');
    expect(pick('sugarcube')?.version).toBe('2.37.3');
    expect(pick('SUGARCUBE')?.version).toBe('2.37.3');
  });

  it('ranks a release above its prereleases and never treats them as the same version (#162)', () => {
    const pre = [
      { name: 'Pre', version: '2.0.0' },
      { name: 'Pre', version: '2.0.0-beta.1' },
    ];
    for (const list of [pre, [...pre].reverse()]) {
      const pick = (request: FormatRequest, allowOlder = false) =>
        selectFormatCandidate(request, list, (c) => c, { allowOlder })?.version;
      expect(pick({ kind: 'name', name: 'Pre', version: '2.0.0' })).toBe('2.0.0');
      expect(pick({ kind: 'name', name: 'Pre', version: '2.0.0-beta.1' })).toBe('2.0.0-beta.1');
      expect(pick({ kind: 'name', name: 'Pre', version: '1.0.0' })).toBeUndefined();
      expect(pick({ kind: 'id', id: 'pre-2' })).toBe('2.0.0');
    }
    const betaOnly = [{ name: 'Pre', version: '2.0.0-beta.1' }];
    const request: FormatRequest = { kind: 'name', name: 'Pre', version: '2.0.0' };
    expect(selectFormatCandidate(request, betaOnly, (c) => c)).toBeUndefined();
    expect(selectFormatCandidate(request, betaOnly, (c) => c, { allowOlder: true })?.version).toBe('2.0.0-beta.1');
  });
});

describe('format versions such as v1.0.0 and 1.0 (#164)', () => {
  it('parses the format and keeps the version as written', () => {
    const data = parseFormatJSON('window.storyFormat({"name":"V","version":"v1.0.0","source":"{{STORY_DATA}}"});');
    expect(data?.version).toBe('v1.0.0');
    expect(
      parseFormatJSON('window.storyFormat({"name":"V","version":"1.0","source":"{{STORY_DATA}}"});')?.version,
    ).toBe('1.0');
  });

  it('builds IDs from the coerced major version', () => {
    expect(makeFormatId('VPrefix', 'v1.0.0')).toBe('vprefix-1');
    expect(makeFormatId('TwoPart', '1.0')).toBe('twopart-1');
  });
});

describe('relaxed format.js parsing (#154)', () => {
  /** What Twine 2 sees: it runs format.js as JavaScript. */
  function evaluate(formatJs: string): Record<string, unknown> {
    let captured: unknown;
    const run = new Function('window', formatJs) as (window: { storyFormat: (o: unknown) => void }) => void;
    run({ storyFormat: (o) => (captured = o) });
    if (typeof captured !== 'object' || captured === null) throw new Error('format.js did not call storyFormat');
    return captured as Record<string, unknown>;
  }

  const sources = {
    apostrophe: `<p class='a'>It's {{STORY_DATA}}</p>`,
    wordColon: 'Hello, world: {{STORY_DATA}}',
    minifiedObject: '<script>var o={a:1,b:2};</script>{{STORY_DATA}}',
    trailingCommaText: '<pre>[1, 2, ]  {a, }</pre>{{STORY_DATA}}',
    escapes: 'line\nbreak \\ "quoted" \u2028 // not a comment /* nor this */ {{STORY_DATA}}',
  };

  /** Escape a string for a single-quoted JavaScript literal. */
  const singleQuote = (s: string): string =>
    `'${s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\u2028/g, '\\u2028')}'`;

  /** Ways to write the same format object in format.js that are not strict JSON. */
  const writers: Record<string, (source: string) => string> = {
    trailingComma: (s) => `window.storyFormat({"name":"T","version":"1.0.0","source":${JSON.stringify(s)},});`,
    unquotedKeys: (s) => `window.storyFormat({name:"T",version:"1.0.0",source:${JSON.stringify(s)}});`,
    singleQuoted: (s) => `window.storyFormat({'name':'T','version':'1.0.0','source':${singleQuote(s)}});`,
    allTogether: (s) =>
      `window.storyFormat({\n  // a comment\n  name: 'T',\n  version: "1.0.0",\n  /* another */ source: ${singleQuote(s)},\n  proofing: false,\n});`,
  };

  for (const [sourceLabel, source] of Object.entries(sources)) {
    for (const [writerLabel, write] of Object.entries(writers)) {
      it(`keeps a source with ${sourceLabel} byte-identical when written with ${writerLabel}`, () => {
        const formatJs = write(source);
        const expected = evaluate(formatJs);
        expect(expected.source).toBe(source);
        const data = parseFormatJSON(formatJs);
        expect(data?.source).toBe(expected.source);
        expect(data?.name).toBe('T');
        expect(data?.version).toBe('1.0.0');
      });
    }
  }

  it('discovers a non-JSON format whose source would break a textual rewrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-relaxed-'));
    try {
      mkdirSync(join(dir, 'x-1'));
      writeFileSync(
        join(dir, 'x-1', 'format.js'),
        `window.storyFormat({name:"X",version:"1.0.0",source:${JSON.stringify(sources.wordColon)}});`,
      );
      const format = discoverFormats([dir]).get('x-1');
      if (!format) throw new Error('expected x-1 to be discovered');
      expect(readFormatSource(format)).toBe(sources.wordColon);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns, naming the format and the reason, when a format.js cannot be used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-relaxed-'));
    try {
      mkdirSync(join(dir, 'broken-1'));
      writeFileSync(
        join(dir, 'broken-1', 'format.js'),
        'window.storyFormat({name: "B", version: "1.0.0", source: x});',
      );
      mkdirSync(join(dir, 'badversion-1'));
      writeFileSync(
        join(dir, 'badversion-1', 'format.js'),
        'window.storyFormat({"name":"V","version":"latest","source":"{{STORY_DATA}}"});',
      );
      const diagnostics: Diagnostic[] = [];
      expect([...discoverAllFormats([dir], diagnostics).keys()]).toEqual([]);
      expect(diagnostics).toEqual([
        { level: 'warning', message: expect.stringMatching(/^format badversion-1: Skipping format; .*"latest"/) },
        {
          level: 'warning',
          message: expect.stringMatching(/^format broken-1: Skipping format; Could not decode story format JSON chunk/),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
