/**
 * The compiler's public API, CLI and type declarations, as the build in dist/ provides them.
 * Matrix groups WRITE, TYPE, FORMAT, RESOLVE, INPUT, OUTPUT, CLI and ABORT (see cases.ts).
 */
import { existsSync, lstatSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import {
  compile,
  compileIncremental,
  compileToFile,
  decompileHTML,
  fetchDirectFormat,
  parseFormatJSON,
} from '@rohal12/twee-ts';
import type { CompileOptions, CompileResult, CompileToFileOptions, FileCacheEntry } from '@rohal12/twee-ts';
import { elements, attr } from '../../test/helpers/html.js';
import {
  defineContracts,
  errorsOf,
  expectNoErrors,
  formatText,
  IFID,
  inline,
  localFormat,
  passageText,
  run,
  serve,
  story,
  write,
} from './harness.js';

const REPO = resolve(import.meta.dirname, '../..');
const CLI = join(REPO, 'dist', 'bin', 'twee-ts.js');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

// Windows only makes symbolic links with a privilege the test runners need not have; the unit
// tests of atomic writes skip them there too.
const noSymlinks = process.platform === 'win32' ? 'symbolic links are not portable to Windows' : undefined;

defineContracts(
  'WRITE',
  {
    'new file': (root) => expectWritten(root, () => undefined),
    'existing file': (root) => expectWritten(root, (output) => write(output, 'previous output')),
    'valid relative symlink': (root) =>
      expectWrittenThroughLink(root, (output, target) => {
        write(target, 'previous target');
        symlinkSync('served.json', output);
      }),
    'absolute dangling symlink': (root) =>
      expectWrittenThroughLink(root, (output, target) => {
        symlinkSync(target, output);
      }),
    'relative dangling symlink': (root) =>
      expectWrittenThroughLink(root, (output) => {
        symlinkSync('served.json', output);
      }),
    'dangling symlink chain': (root) =>
      expectWrittenThroughLink(root, (output) => {
        symlinkSync('served.json', join(root, 'middle.json'));
        symlinkSync('middle.json', output);
      }),
    'symlink cycle': async (root) => {
      const output = join(root, 'output.json');
      symlinkSync('other.json', output);
      symlinkSync('output.json', join(root, 'other.json'));
      await expect(compileToFile(jsonToFile(output))).rejects.toThrow(/ELOOP|symbolic link|symlink/i);
      expect(lstatSync(output).isSymbolicLink(), 'a failed write must keep the cyclic link').toBe(true);
    },
  },
  { skip: (variant) => (variant.includes('symlink') ? noSymlinks : undefined) },
);

function jsonToFile(outFile: string): CompileToFileOptions {
  return { sources: [inline()], outputMode: 'json', outFile };
}

async function expectWritten(root: string, prepare: (output: string) => void): Promise<void> {
  const output = join(root, 'output.json');
  prepare(output);
  const result = await compileToFile(jsonToFile(output));
  expectNoErrors(result);
  expect(readFileSync(output, 'utf8')).toBe(result.output);
}

/** The output path is a link (to served.json); the build must write the link's target and keep the link. */
async function expectWrittenThroughLink(
  root: string,
  prepare: (output: string, target: string) => void,
): Promise<void> {
  const output = join(root, 'output.json');
  const target = join(root, 'served.json');
  prepare(output, target);
  const result = await compileToFile(jsonToFile(output));
  expectNoErrors(result);
  expect(lstatSync(output).isSymbolicLink(), 'the atomic write replaced the output link').toBe(true);
  expect(existsSync(target), 'the target the link names was not created').toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(result.output);
}

defineContracts('TYPE', {
  'tag append': (root) => expectRejectedWrite(root, "passage.tags.push('Twine.private');"),
  'tag index assignment': (root) => expectRejectedWrite(root, "passage.tags[0] = 'script';"),
  'metadata property assignment': (root) =>
    expectRejectedWrite(root, "if (passage.metadata) passage.metadata.position = '0,0';"),
  'source property assignment': (root) => expectRejectedWrite(root, 'if (passage.source) passage.source.line = 99;'),
  'name assignment': (root) => expectRejectedWrite(root, "passage.name = 'Changed';"),
});

/**
 * Type-checks `statement` against the published declarations (dist/index.d.ts) under an
 * `@ts-expect-error` directive: the check passes only when TypeScript rejects the write.
 */
async function expectRejectedWrite(root: string, statement: string): Promise<void> {
  const probe = write(
    join(root, 'readonly.mts'),
    `import type { CompileResult } from ${JSON.stringify(join(REPO, 'dist', 'index.js'))};\n` +
      'declare const result: CompileResult;\nconst passage = result.story.passages[0];\n' +
      'if (passage === undefined) throw new Error();\n' +
      `// @ts-expect-error The public read-only result must reject this write.\n${statement}\n`,
  );
  const options = ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2024'];
  const modules = ['--module', 'Node16', '--moduleResolution', 'Node16'];
  const result = await run(process.execPath, [TSC, ...options, ...modules, probe], { cwd: root });
  const output = `${result.stdout}${result.stderr}`;
  expect(output, 'TypeScript accepted the write: the @ts-expect-error directive is unused').not.toContain('TS2578');
  expect(output).toBe('');
  expect(result.status).toBe(0);
}

const FORMAT_NAME = 'ValidationFixture';
const FORMAT_PAGE = '<html>{{STORY_DATA}} {literal}</html>';
const plainFormat = formatText(FORMAT_NAME, '1.0.0', FORMAT_PAGE);

defineContracts('FORMAT', {
  'strict object': (root) => expectFormatDecoded(root, plainFormat),
  'relaxed object': (root) =>
    expectFormatDecoded(
      root,
      `window.storyFormat({name:'${FORMAT_NAME}',version:'1.0.0',source:${JSON.stringify(FORMAT_PAGE)},});`,
    ),
  'comment inside object': (root) => expectFormatDecoded(root, plainFormat.replace('{', '{/* {comment} */')),
  'leading brace comment': (root) => expectFormatDecoded(root, `/* Copyright {license} */\n${plainFormat}`),
  'trailing brace comment': (root) => expectFormatDecoded(root, `${plainFormat}\n// Copyright {license}`),
  'surrounding brace comments': (root) => expectFormatDecoded(root, `/* {before} */\n${plainFormat}\n/* {after} */`),
  // FORMAT_PAGE itself has braces inside the source value.
  'braces inside a value': (root) => expectFormatDecoded(root, plainFormat),
});

/** The parser, a local format and a downloaded format (then used offline) all read `text` as the fixture format. */
async function expectFormatDecoded(root: string, text: string): Promise<void> {
  const decoded = parseFormatJSON(text);
  expect(decoded?.name).toBe(FORMAT_NAME);
  expect(decoded?.source).toBe(FORMAT_PAGE);

  const local = localFormat(root);
  write(join(root, 'formats', local.formatId, 'format.js'), text);
  const fromLocal = await compile({ ...local.options, formatId: local.formatId, sources: [inline()] });
  expectNoErrors(fromLocal);
  expect(fromLocal.format?.name).toBe(FORMAT_NAME);

  await serve(
    (_request, response) => response.end(text),
    async (origin) => {
      const url = `${origin}/format.js`;
      expect((await fetchDirectFormat(url)).name).toBe(FORMAT_NAME);
      const offline = await compile({
        sources: [inline()],
        formatId: 'validationfixture-1',
        formatUrls: [url],
        formatPaths: [],
        useTweegoPath: false,
        noRemote: true,
      });
      expectNoErrors(offline);
      expect(offline.format?.name).toBe(FORMAT_NAME);
    },
  );
}

defineContracts('RESOLVE', {
  'local exact': (root) => expectResolved(root, 'local', '1.1.0'),
  'local newer': (root) => expectResolved(root, 'local', '1.2.0'),
  'local older': (root) => expectResolved(root, 'local', '1.0.0'),
  'URL exact': (root) => expectResolved(root, 'url', '1.1.0'),
  'URL newer': (root) => expectResolved(root, 'url', '1.2.0'),
  'URL older': (root) => expectResolved(root, 'url', '1.0.0'),
  'index cache exact': (root) => expectResolved(root, 'index', '1.1.0'),
  'index cache newer': (root) => expectResolved(root, 'index', '1.2.0'),
  'index cache older': (root) => expectResolved(root, 'index', '1.0.0'),
});

/**
 * The story asks for ValidationResolution 1.1.0 and only `available` exists, as a local format, a
 * format URL, or an index entry: the same major version is used, and only an older one warns.
 * The URL and index downloads are then used again offline, from the cache.
 */
async function expectResolved(root: string, kind: 'local' | 'url' | 'index', available: string): Promise<void> {
  const name = 'ValidationResolution';
  const text = formatText(name, available);
  const base: CompileOptions = {
    sources: [inline(story('Hello', { format: name, 'format-version': '1.1.0' }))],
    useTweegoPath: false,
    formatPaths: [],
    noRemote: true,
  };
  const expectSelected = (result: CompileResult): void => {
    expectNoErrors(result);
    expect(result.format?.version).toBe(available);
    const warned = result.diagnostics.some((d) => d.level === 'warning' && /using .* instead/.test(d.message));
    expect(warned, 'only a fallback to an older version warns').toBe(available === '1.0.0');
  };
  if (kind === 'local') {
    const formats = join(root, 'formats');
    write(join(formats, 'validation-resolution-1', 'format.js'), text);
    expectSelected(await compile({ ...base, formatPaths: [formats] }));
    return;
  }
  const index = JSON.stringify({ twine2: [{ name, version: available, files: ['format.js'], proofing: false }] });
  await serve(
    (request, response) => response.end(request.url === '/index.json' ? index : text),
    async (origin) => {
      const remote: CompileOptions =
        kind === 'url'
          ? { ...base, formatUrls: [`${origin}/format.js`] }
          : { ...base, formatIndices: [`${origin}/index.json`] };
      expectSelected(await compile({ ...remote, noRemote: false }));
      expectSelected(await compile(remote));
    },
  );
}

defineContracts('INPUT', {
  'file and inline normalization': async (root) => {
    const text = `﻿${story().replaceAll('\n', '\r\n')}`;
    const file = write(join(root, 'story.tw'), text);
    const fromFile = await compile({ sources: [file], outputMode: 'json' });
    const fromInline = await compile({ sources: [inline(text)], outputMode: 'json' });
    expect(fromFile.output).toBe(fromInline.output);
  },
  'mixed source precedence': async (root) => {
    const file = write(join(root, 'story.tw'), story());
    for (const [sources, expected] of [
      [[file, inline(story('inline wins'))], 'inline wins'],
      [[inline(story('inline loses')), file], 'Hello'],
    ] as const) {
      const plain = await compile({ sources, outputMode: 'json' });
      const cached = await compileIncremental({ sources, outputMode: 'json' }, new Map());
      expect(cached.output).toBe(plain.output);
      expect(passageText(plain, 'Start')).toBe(expected);
    }
  },
  'cold and warm cache parity': async (root) => {
    const options: CompileOptions = { sources: [write(join(root, 'story.tw'), story())], outputMode: 'json' };
    const cache = new Map<string, FileCacheEntry>();
    const cold = await compileIncremental(options, cache);
    const warm = await compileIncremental(options, cache, new Set());
    expect(warm.output).toBe(cold.output);
  },
  'forced change with unchanged mtime': async (root) => {
    const file = write(join(root, 'story.tw'), story());
    const options: CompileOptions = { sources: [file], outputMode: 'json' };
    const cache = new Map<string, FileCacheEntry>();
    await compileIncremental(options, cache);
    const stamp = statSync(file);
    write(file, story('changed'));
    utimesSync(file, stamp.atime, stamp.mtime);
    expect(passageText(await compileIncremental(options, cache, new Set([file])), 'Start')).toBe('changed');
  },
  'parse-option invalidation': async (root) => {
    const file = write(join(root, 'story.tw'), story('   padded   '));
    const cache = new Map<string, FileCacheEntry>();
    const trimmed = await compileIncremental({ sources: [file], outputMode: 'json', trim: true }, cache);
    const untrimmed = await compileIncremental({ sources: [file], outputMode: 'json', trim: false }, cache, new Set());
    expect(passageText(trimmed, 'Start')).toBe('padded');
    expect(passageText(untrimmed, 'Start')).toBe('   padded   ');
  },
  'generated-name collision': async (root) => {
    const file = write(join(root, 'story.tw'), story());
    const a = write(join(root, 'a', 'code.js'), 'globalThis.firstCode = 1;');
    const b = write(join(root, 'b', 'code.js'), 'globalThis.secondCode = 2;');
    const result = await compile({ sources: [file, a, b], outputMode: 'json' });
    const scripts = result.story.passages.filter((p) => p.tags.includes('script'));
    expect(new Set(scripts.map((p) => p.name)).size).toBe(2);
    expect(result.output).toContain('firstCode');
    expect(result.output).toContain('secondCode');
  },
});

defineContracts('OUTPUT', {
  'HTML metadata and text round trip': async (root) => {
    const text = 'Unicode café & <literal> {{STORY_NAME}} $&';
    const { formatId, options } = localFormat(root);
    const result = await compile({
      ...options,
      formatId,
      sources: [inline(story(text, { tags: 'fiction', zoom: 2 }))],
    });
    expectNoErrors(result);
    const imported = decompileHTML(result.output).story;
    expect(imported.ifid).toBe(IFID);
    expect(imported.twine2.start).toBe('Start');
    expect(imported.twine2.tags).toBe('fiction');
    expect(imported.twine2.zoom).toBe(2);
    expect(imported.passages.find((p) => p.name === 'Start')?.text).toBe(text);
  },
  'JSON start and debug overrides': async () => {
    const result = await compile({
      sources: [inline(story('Hello', {}, '\n:: Begin\nBegin here'))],
      outputMode: 'json',
      startPassage: 'Begin',
      testMode: true,
    });
    expect(JSON.parse(result.output)).toMatchObject({ start: 'Begin' });
    expect(result.story.twine2.options.get('debug')).toBe(true);
  },
  'private passage omitted': (root) => expectPrivatePassage(root, false),
  'private start rejected': (root) => expectPrivatePassage(root, true),
  'effective Twee metadata round trip': async () => {
    const result = await compile({
      sources: [inline(story('Hello', {}, '\n:: Begin\nBegin here'))],
      outputMode: 'twee3',
      startPassage: 'Begin',
      testMode: true,
    });
    const back = await compile({ sources: [inline(result.output)], outputMode: 'json' });
    expect(back.story.twine2.start).toBe('Begin');
    expect(back.story.twine2.options.get('debug')).toBe(true);
    expect(back.story.ifid).toBe(IFID);
  },
  'missing IFID reported': async () => {
    // Twine 2 story data requires an IFID; Twee, JSON and Twine 1 output do not, as in Tweego (#370).
    const result = await compile({ sources: [inline(':: Start\nHello')], outputMode: 'twine2-archive' });
    expect(errorsOf(result).some((message) => message.includes('IFID'))).toBe(true);
  },
});

/** A Twine.private passage is not in the HTML; naming it as the start passage is an error. */
async function expectPrivatePassage(root: string, asStart: boolean): Promise<void> {
  const { formatId, options } = localFormat(root);
  const result = await compile({
    ...options,
    formatId,
    sources: [inline(story('Hello', {}, '\n:: Hidden [Twine.private]\nPrivate content'))],
    ...(asStart ? { startPassage: 'Hidden' } : {}),
  });
  const passages = elements(result.output, (e) => e.tagName === 'tw-passagedata');
  expect(passages.map((e) => attr(e, 'name'))).not.toContain('Hidden');
  if (asStart) expect(errorsOf(result)).not.toEqual([]);
  else expectNoErrors(result);
}

defineContracts('CLI', {
  'compile error preserves previous output': async (root) => {
    const output = write(join(root, 'output.html'), 'last good output');
    const file = write(join(root, 'story.tw'), ':: Start\nNo IFID');
    const result = await run(process.execPath, [CLI, '--no-config', '--archive-twine2', '-o', output, file], {
      cwd: root,
    });
    expect(result.status).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe('last good output');
  },
  'output inside sources excluded on repeat build': async (root) => {
    write(join(root, 'story.tw'), story());
    const output = join(root, 'output.html');
    const args = [CLI, '--no-config', '--json', '-o', output, root];
    const first = await run(process.execPath, args, { cwd: root });
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const firstOutput = readFileSync(output, 'utf8');
    const second = await run(process.execPath, args, { cwd: root });
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(firstOutput);
  },
});

defineContracts('ABORT', {
  'pre-aborted compile': async (root) => {
    const output = write(join(root, 'output.json'), 'previous output');
    const controller = new AbortController();
    const reason = new Error('validation cancelled');
    controller.abort(reason);
    await expect(compileToFile({ ...jsonToFile(output), signal: controller.signal })).rejects.toBe(reason);
    expect(readFileSync(output, 'utf8')).toBe('previous output');
  },
  'abort during direct format request': async (root) => {
    const output = write(join(root, 'output.html'), 'previous output');
    const controller = new AbortController();
    const reason = new Error('validation cancelled');
    await serve(
      (_request, response) => {
        controller.abort(reason);
        response.end(formatText('ValidationAbort'));
      },
      async (origin) => {
        const build = compileToFile({
          sources: [inline()],
          outFile: output,
          signal: controller.signal,
          formatId: 'validationabort-1',
          formatUrls: [`${origin}/format.js`],
          formatPaths: [],
          useTweegoPath: false,
          formatFetchTimeout: 1000,
        });
        await expect(build).rejects.toBe(reason);
      },
    );
    expect(readFileSync(output, 'utf8')).toBe('previous output');
  },
});
