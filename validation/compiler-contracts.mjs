/**
 * Fixed public-behavior review matrix. Known failures remain failures.
 * Run after pnpm run build; see docs/compiler-validation.md.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { parseDocument } from 'htmlparser2';
import { build, createServer as createViteServer, version as viteVersion } from 'vite';
import {
  compile,
  compileIncremental,
  compileToFile,
  decompileHTML,
  fetchAndCacheFormat,
  fetchDirectFormat,
  parseFormatJSON,
} from '../dist/index.js';
import { tweeTsPlugin } from '../dist/plugins/vite.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_REVISION = 1;
const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const ISSUE_BASE = 'https://github.com/rohal12/twee-ts/issues/';
const { values } = parseArgs({
  options: { report: { type: 'string' }, baseline: { type: 'string' } },
});
const cases = [];

function declareCases(prefix, invariant, variants, ticket, check) {
  variants.forEach((variant, index) => {
    cases.push({
      id: `${prefix}-${String(index + 1).padStart(2, '0')}`,
      invariant,
      variant,
      ticket: ticket === undefined ? null : `${ISSUE_BASE}${ticket}`,
      check,
    });
  });
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function story(text = 'Hello', metadata = {}, extra = '') {
  return `:: StoryData\n${JSON.stringify({ ifid: IFID, ...metadata })}\n\n:: StoryTitle\nValidation Story\n\n:: Start [location]\n${text}\n${extra}`;
}

function inline(content = story()) {
  return { filename: 'story.tw', content };
}

function formatText(name = 'ValidationFixture', version = '1.0.0', source = page()) {
  return `window.storyFormat(${JSON.stringify({ name, version, source })});`;
}

function page(prefix = '', head = '<head>') {
  return `${prefix}<!doctype html><html>${head}<title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>`;
}

function localOptions(root, source = page()) {
  const formats = join(root, 'formats');
  write(join(formats, 'validation-fixture-1', 'format.js'), formatText('ValidationFixture', '1.0.0', source));
  return { formatId: 'validation-fixture-1', formatPaths: [formats], useTweegoPath: false, noRemote: true };
}

function nodes(html, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(parseDocument(html));
  return found;
}

function nodeText(node) {
  return (node.children ?? []).map((child) => child.data ?? '').join('');
}

function noErrors(result) {
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.level === 'error'),
    [],
  );
}

async function serve(handler, action) {
  const server = createHttpServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    return await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

async function devHtml(root, pluginOptions, overrides = {}, extras = []) {
  const messages = [];
  const logger = {
    info() {},
    warn() {},
    warnOnce() {},
    clearScreen() {},
    error(message) {
      messages.push(message);
    },
    hasErrorLogged() {
      return false;
    },
    hasWarned: false,
  };
  const server = await createViteServer({
    configFile: false,
    root,
    logLevel: 'silent',
    customLogger: logger,
    plugins: [...extras, tweeTsPlugin(pluginOptions)],
    server: { host: '127.0.0.1', port: 0 },
    ...overrides,
  });
  try {
    await server.listen();
    const html = await (await fetch(`http://127.0.0.1:${server.httpServer.address().port}`)).text();
    assert(!html.includes('The story has not compiled yet.'), messages.join('\n') || 'dev served waiting page');
    return html;
  } finally {
    await server.close();
  }
}

declareCases(
  'WRITE',
  'Atomic output preserves destination and link intent',
  [
    'new file',
    'existing file',
    'valid relative symlink',
    'absolute dangling symlink',
    'relative dangling symlink',
    'dangling symlink chain',
    'symlink cycle',
  ],
  219,
  async (root, variant) => {
    const target = join(root, 'served.json');
    const output = join(root, 'output.json');
    const options = { sources: [inline()], outputMode: 'json', outFile: output };
    if (variant === 'existing file') write(output, 'previous output');
    if (variant === 'valid relative symlink') write(target, 'previous target');
    if (variant === 'absolute dangling symlink') symlinkSync(target, output);
    if (variant === 'valid relative symlink' || variant === 'relative dangling symlink')
      symlinkSync('served.json', output);
    if (variant === 'dangling symlink chain') {
      symlinkSync('served.json', join(root, 'middle.json'));
      symlinkSync('middle.json', output);
    }
    if (variant === 'symlink cycle') {
      symlinkSync('other.json', output);
      symlinkSync('output.json', join(root, 'other.json'));
      await assert.rejects(compileToFile(options), /ELOOP|symlink|symbolic|link/i);
      assert(lstatSync(output).isSymbolicLink(), 'failed write must preserve the cyclic link');
      return;
    }
    const result = await compileToFile(options);
    noErrors(result);
    if (variant.includes('symlink')) {
      assert(lstatSync(output).isSymbolicLink(), 'atomic write replaced the output symlink');
      assert(existsSync(target), 'intended target was not created');
      assert.equal(readFileSync(target, 'utf8'), result.output);
    } else {
      assert.equal(readFileSync(output, 'utf8'), result.output);
    }
  },
);

declareCases(
  'TYPE',
  'ReadonlyPassage rejects writes at its public boundaries',
  [
    'tag append',
    'tag index assignment',
    'metadata property assignment',
    'source property assignment',
    'name assignment',
  ],
  220,
  async (root, variant) => {
    const statements = {
      'tag append': "passage.tags.push('Twine.private');",
      'tag index assignment': "passage.tags[0] = 'script';",
      'metadata property assignment': "passage.metadata!.position = '0,0';",
      'source property assignment': 'passage.source!.line = 99;',
      'name assignment': "passage.name = 'Changed';",
    };
    const path = write(
      join(root, 'readonly.mts'),
      `import type { CompileResult } from ${JSON.stringify(join(REPO, 'dist', 'index.js'))};\n` +
        'declare const result: CompileResult;\nconst passage = result.story.passages[0]!;\n' +
        `// @ts-expect-error The public read-only result must reject this mutation.\n${statements[variant]}\n`,
    );
    try {
      execFileSync(
        join(REPO, 'node_modules', '.bin', 'tsc'),
        [
          '--ignoreConfig',
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2024',
          '--module',
          'Node16',
          '--moduleResolution',
          'Node16',
          path,
        ],
        { cwd: REPO, encoding: 'utf8', timeout: 10000 },
      );
    } catch (error) {
      const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      if (!detail.includes('TS2578')) throw new Error(`type probe setup failed: ${detail}`, { cause: error });
      assert.fail(`TypeScript accepted ${variant}; the @ts-expect-error directive was unused`);
    }
  },
);

declareCases(
  'FORMAT',
  'Lexically equivalent storyFormat wrappers decode identically',
  [
    'strict object',
    'relaxed object',
    'comment inside object',
    'leading brace comment',
    'trailing brace comment',
    'surrounding brace comments',
    'braces inside a value',
  ],
  221,
  async (root, variant) => {
    const name = 'ValidationFixture';
    const source = '<html>{{STORY_DATA}} {literal}</html>';
    const plain = formatText(name, '1.0.0', source);
    const wrappers = {
      'strict object': plain,
      'relaxed object': `window.storyFormat({name:'${name}',version:'1.0.0',source:${JSON.stringify(source)},});`,
      'comment inside object': plain.replace('{', '{/* {comment} */'),
      'leading brace comment': `/* Copyright {license} */\n${plain}`,
      'trailing brace comment': `${plain}\n// Copyright {license}`,
      'surrounding brace comments': `/* {before} */\n${plain}\n/* {after} */`,
      'braces inside a value': plain,
    };
    const text = wrappers[variant];
    const failures = [];
    const checkPath = async (label, action) => {
      try {
        await action();
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    };
    await checkPath('parser', () => {
      const decoded = parseFormatJSON(text);
      assert(decoded, 'valid format wrapper was rejected');
      assert.equal(decoded.name, name);
      assert.equal(decoded.source, source);
    });
    await checkPath('local compilation', async () => {
      const options = localOptions(root);
      write(join(root, 'formats', options.formatId, 'format.js'), text);
      const result = await compile({ ...options, sources: [inline()] });
      noErrors(result);
      assert.equal(result.format.name, name);
    });
    await checkPath('direct download and offline compilation', () =>
      serve(
        (_request, response) => response.end(text),
        async (origin) => {
          const url = `${origin}/format.js`;
          const downloaded = await fetchDirectFormat(url);
          assert.equal(downloaded.name, name);
          const result = await compile({
            sources: [inline()],
            formatId: 'validationfixture-1',
            formatUrls: [url],
            formatPaths: [],
            useTweegoPath: false,
            noRemote: true,
          });
          noErrors(result);
          assert.equal(result.format.name, name);
        },
      ),
    );
    assert.deepEqual(failures, [], failures.join('\n'));
  },
);

declareCases(
  'RESOLVE',
  'Format selection and warnings agree across supported source kinds',
  [
    'local exact',
    'local newer',
    'local older',
    'URL exact',
    'URL newer',
    'URL older',
    'index cache exact',
    'index cache newer',
    'index cache older',
  ],
  224,
  async (root, variant) => {
    const name = 'ValidationResolution';
    const version = variant.endsWith('newer') ? '1.2.0' : variant.endsWith('older') ? '1.0.0' : '1.1.0';
    const text = formatText(name, version);
    const sources = [inline(story('Hello', { format: name, 'format-version': '1.1.0' }))];
    let selected;
    const options = { sources, noRemote: true, useTweegoPath: false, formatPaths: [] };
    if (variant.startsWith('local')) {
      const formats = join(root, 'formats');
      write(join(formats, 'validation-resolution-1', 'format.js'), text);
      selected = await compile({ ...options, formatPaths: [formats] });
    } else {
      selected = await serve(
        (_request, response) => response.end(text),
        async (origin) => {
          const url = `${origin}/format.js`;
          if (variant.startsWith('URL')) {
            await fetchDirectFormat(url);
            return compile({ ...options, formatUrls: [url] });
          }
          await fetchAndCacheFormat({ name, version, proofing: false, files: ['format.js'], checksums: {} }, url);
          return compile(options);
        },
      );
    }
    noErrors(selected);
    assert.equal(selected.format.version, version);
    const fallbackWarning = selected.diagnostics.some((diagnostic) => /using .* instead/.test(diagnostic.message));
    assert.equal(fallbackWarning, variant.endsWith('older'), 'older fallback must warn and other selections must not');
  },
);

const headVariants = [
  'ordinary head',
  'comment look-alike',
  'script look-alike',
  'attribute look-alike',
  'quoted head attribute',
];
function headTemplate(variant) {
  const prefixes = {
    'ordinary head': '',
    'comment look-alike': '<!-- example <head></head> -->',
    'script look-alike': '<script>const example="<head></head>";</script>',
    'attribute look-alike': '<meta data-example="<head></head>">',
    'quoted head attribute': '',
  };
  const head = variant === 'quoted head attribute' ? '<head data-example="<head>" data-other=">">' : '<head>';
  return { source: page(prefixes[variant], head), preserved: prefixes[variant] || head };
}

declareCases(
  'HEAD',
  'HTML injections preserve literals and create executable elements',
  [...headVariants.map((variant) => `module: ${variant}`), ...headVariants.map((variant) => `client: ${variant}`)],
  223,
  async (root, variant) => {
    const [kind, input] = variant.split(': ');
    const { source, preserved } = headTemplate(input);
    const options = localOptions(root, source);
    let html;
    if (kind === 'module') {
      const module = write(join(root, 'injected.js'), 'globalThis.validationModule = 42;');
      html = (await compile({ ...options, sources: [inline()], modules: [module] })).output;
      const injected = nodes(html, (node) => node.name === 'script' && node.attribs?.id === 'script-module-injected');
      assert.equal(injected.length, 1, 'module script must be an actual HTML element');
      assert.equal(nodeText(injected[0]), 'globalThis.validationModule = 42;');
    } else {
      const storyFile = write(join(root, 'story.tw'), story());
      html = await devHtml(root, { sources: [storyFile], format: options.formatId, compileOptions: options });
      const clients = nodes(html, (node) => node.name === 'script' && node.attribs?.src === '/@vite/client');
      assert.equal(clients.length, 1, 'Vite client must be an actual HTML element');
    }
    assert(html.includes(preserved), 'injection changed literal comment/script/attribute text');
    for (const script of nodes(html, (node) => node.name === 'script' && !node.attribs?.src)) {
      new Script(nodeText(script));
    }
  },
);

declareCases(
  'VITE',
  'Development and production entry builds preserve user configuration',
  [
    'ordinary inline config',
    'inline define',
    'inline alias',
    'inline virtual-module plugin',
    'file config with inline define override',
  ],
  222,
  async (root, variant) => {
    const formatOptions = localOptions(root);
    const storyFile = write(join(root, 'story.tw'), story());
    const entry = join(root, 'entry.js');
    const marker = 'VALIDATION_INLINE_ENTRY';
    let overrides = {};
    let extras = [];
    if (variant === 'ordinary inline config') write(entry, `globalThis.validationEntry = ${JSON.stringify(marker)};`);
    if (variant === 'inline define' || variant === 'file config with inline define override') {
      write(entry, 'globalThis.validationEntry = __VALIDATION_MARKER__;');
      overrides = { define: { __VALIDATION_MARKER__: JSON.stringify(marker) } };
    }
    if (variant === 'inline alias') {
      const aliasTarget = write(join(root, 'value.js'), `export default ${JSON.stringify(marker)};`);
      write(entry, 'import value from "validation-alias"; globalThis.validationEntry = value;');
      overrides = { resolve: { alias: { 'validation-alias': aliasTarget } } };
    }
    if (variant === 'inline virtual-module plugin') {
      write(entry, 'import value from "virtual:validation"; globalThis.validationEntry = value;');
      extras = [
        {
          name: 'validation-virtual',
          resolveId(id) {
            if (id === 'virtual:validation') return '\0virtual:validation';
          },
          load(id) {
            if (id === '\0virtual:validation') return `export default ${JSON.stringify(marker)};`;
          },
        },
      ];
    }
    if (variant === 'file config with inline define override') {
      overrides.configFile = write(
        join(root, 'vite.config.mjs'),
        'export default { define: { __VALIDATION_MARKER__: JSON.stringify("VALIDATION_FILE_ENTRY") } };',
      );
    }
    const pluginOptions = {
      sources: [storyFile],
      format: formatOptions.formatId,
      entry,
      compileOptions: formatOptions,
    };
    const bundle = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      ...overrides,
      plugins: [...extras, tweeTsPlugin(pluginOptions)],
      build: { write: false },
    });
    const production = bundle.output.find((item) => item.fileName === 'index.html')?.source;
    assert.equal(typeof production, 'string');
    assert(production.includes(marker), 'production did not preserve user configuration');
    const development = await devHtml(root, pluginOptions, overrides, extras);
    assert(development.includes(marker), 'development did not preserve the same user configuration as production');
    assert(!development.includes('VALIDATION_FILE_ENTRY'), 'file config incorrectly displaced the inline override');
  },
);

declareCases(
  'INPUT',
  'Source loading and caching preserve effective authored data',
  [
    'file and inline normalization',
    'mixed source precedence',
    'cold and warm cache parity',
    'forced change with unchanged mtime',
    'parse-option invalidation',
    'generated-name collision',
  ],
  undefined,
  async (root, variant) => {
    const file = write(join(root, 'story.tw'), story());
    const options = { sources: [file], outputMode: 'json' };
    const cache = new Map();
    if (variant === 'file and inline normalization') {
      const text = `\ufeff${story().replaceAll('\n', '\r\n')}`;
      write(file, text);
      assert.equal((await compile(options)).output, (await compile({ ...options, sources: [inline(text)] })).output);
    } else if (variant === 'mixed source precedence') {
      for (const sources of [
        [file, inline(story('inline wins'))],
        [inline(story('inline loses')), file],
      ]) {
        const plain = await compile({ ...options, sources });
        const cached = await compileIncremental({ ...options, sources }, new Map());
        assert.equal(plain.output, cached.output);
        assert.equal(
          plain.story.passages.find((passage) => passage.name === 'Start').text,
          typeof sources[1] === 'string' ? 'Hello' : 'inline wins',
        );
      }
    } else if (variant === 'cold and warm cache parity') {
      const cold = await compileIncremental(options, cache);
      const warm = await compileIncremental(options, cache, new Set());
      assert.equal(cold.output, warm.output);
    } else if (variant === 'forced change with unchanged mtime') {
      await compileIncremental(options, cache);
      const stamp = statSync(file);
      write(file, story('changed'));
      utimesSync(file, stamp.atime, stamp.mtime);
      const result = await compileIncremental(options, cache, new Set([file]));
      assert.equal(result.story.passages.find((passage) => passage.name === 'Start').text, 'changed');
    } else if (variant === 'parse-option invalidation') {
      write(file, story('   padded   '));
      const trimmed = await compileIncremental({ ...options, trim: true }, cache);
      const untrimmed = await compileIncremental({ ...options, trim: false }, cache, new Set());
      assert.equal(trimmed.story.passages.find((passage) => passage.name === 'Start').text, 'padded');
      assert.equal(untrimmed.story.passages.find((passage) => passage.name === 'Start').text, '   padded   ');
    } else {
      const a = write(join(root, 'a', 'code.js'), 'globalThis.firstCode = 1;');
      const b = write(join(root, 'b', 'code.js'), 'globalThis.secondCode = 2;');
      const result = await compile({ sources: [file, a, b], outputMode: 'json' });
      const scripts = result.story.passages.filter((passage) => passage.tags.includes('script'));
      assert.equal(new Set(scripts.map((passage) => passage.name)).size, 2);
      assert(JSON.parse(result.output).script.includes('firstCode'));
      assert(JSON.parse(result.output).script.includes('secondCode'));
    }
  },
);

declareCases(
  'OUTPUT',
  'Output modes preserve their documented metadata and omissions',
  [
    'HTML metadata and text round trip',
    'JSON start and debug overrides',
    'private passage omitted',
    'private start rejected',
    'effective Twee metadata round trip',
    'missing IFID reported',
  ],
  undefined,
  async (root, variant) => {
    const options = localOptions(root);
    if (variant === 'HTML metadata and text round trip') {
      const text = 'Unicode café & <literal> {{STORY_NAME}} $&';
      const result = await compile({ ...options, sources: [inline(story(text, { tags: 'fiction', zoom: 2 }))] });
      noErrors(result);
      const imported = decompileHTML(result.output);
      assert.equal(imported.story.ifid, IFID);
      assert.equal(imported.story.twine2.start, 'Start');
      assert.equal(imported.story.twine2.tags, 'fiction');
      assert.equal(imported.story.twine2.zoom, 2);
      assert.equal(imported.story.passages.find((passage) => passage.name === 'Start').text, text);
    } else if (variant === 'JSON start and debug overrides') {
      const result = await compile({
        sources: [inline(story('Hello', {}, '\n:: Begin\nBegin here'))],
        outputMode: 'json',
        startPassage: 'Begin',
        testMode: true,
      });
      assert.equal(JSON.parse(result.output).start, 'Begin');
      assert.equal(result.story.twine2.options.get('debug'), true);
    } else if (variant === 'private passage omitted' || variant === 'private start rejected') {
      const sources = [inline(story('Hello', {}, '\n:: Hidden [Twine.private]\nPrivate content'))];
      const result = await compile({
        ...options,
        sources,
        ...(variant === 'private start rejected' ? { startPassage: 'Hidden' } : {}),
      });
      assert(
        !nodes(result.output, (node) => node.name === 'tw-passagedata').some((node) => node.attribs?.name === 'Hidden'),
      );
      if (variant === 'private start rejected')
        assert(result.diagnostics.some((diagnostic) => diagnostic.level === 'error'));
      else noErrors(result);
    } else if (variant === 'effective Twee metadata round trip') {
      const result = await compile({
        sources: [inline(story('Hello', {}, '\n:: Begin\nBegin here'))],
        outputMode: 'twee3',
        startPassage: 'Begin',
        testMode: true,
      });
      const back = await compile({ sources: [inline(result.output)], outputMode: 'json' });
      assert.equal(back.story.twine2.start, 'Begin');
      assert.equal(back.story.twine2.options.get('debug'), true);
      assert.equal(back.story.ifid, IFID);
    } else {
      const result = await compile({ sources: [inline(':: Start\nHello')], outputMode: 'json' });
      assert(result.diagnostics.some((diagnostic) => diagnostic.level === 'error' && /IFID/.test(diagnostic.message)));
    }
  },
);

declareCases(
  'CLI',
  'CLI errors preserve output and generated output never becomes input',
  ['compile error preserves previous output', 'output inside sources excluded on repeat build'],
  undefined,
  async (root, variant) => {
    const cli = join(REPO, 'dist', 'bin', 'twee-ts.js');
    const output = join(root, 'output.html');
    if (variant === 'compile error preserves previous output') {
      write(output, 'last good output');
      const file = write(join(root, 'story.tw'), ':: Start\nNo IFID');
      assert.throws(
        () =>
          execFileSync(process.execPath, [cli, '--no-config', '--json', '-o', output, file], {
            cwd: REPO,
            encoding: 'utf8',
            stdio: 'pipe',
          }),
        (error) => error.status === 1,
      );
      assert.equal(readFileSync(output, 'utf8'), 'last good output');
    } else {
      write(join(root, 'story.tw'), story());
      const args = [cli, '--no-config', '--json', '-o', output, root];
      execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
      const first = readFileSync(output, 'utf8');
      execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
      assert.equal(readFileSync(output, 'utf8'), first);
    }
  },
);

declareCases(
  'ABORT',
  'Cancelled compiles reject with the caller reason and preserve output',
  ['pre-aborted compile', 'abort during direct format request'],
  undefined,
  async (root, variant) => {
    const controller = new AbortController();
    const reason = new Error('validation cancelled');
    const output = write(join(root, 'output.html'), 'previous output');
    if (variant === 'pre-aborted compile') {
      controller.abort(reason);
      await assert.rejects(
        compileToFile({ sources: [inline()], outputMode: 'json', outFile: output, signal: controller.signal }),
        (error) => error === reason,
      );
    } else {
      await serve(
        (_request, response) => {
          controller.abort(reason);
          response.end(formatText('ValidationAbort'));
        },
        async (origin) => {
          await assert.rejects(
            compileToFile({
              sources: [inline()],
              outFile: output,
              signal: controller.signal,
              formatId: 'validationabort-1',
              formatUrls: [`${origin}/format.js`],
              formatPaths: [],
              useTweegoPath: false,
              formatFetchTimeout: 1000,
            }),
            (error) => error === reason,
          );
        },
      );
    }
    assert.equal(readFileSync(output, 'utf8'), 'previous output');
  },
);

assert.equal(cases.length, 59, 'matrix revision 1 has a declared boundary of 59 cases');
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, 'case IDs must be unique');

const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const parsed = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
  if (parsed.hostname !== '127.0.0.1')
    throw new Error(`validation forbids external network access: ${parsed.hostname}`);
  return originalFetch(url, options);
};

const originalCacheHome = process.env.XDG_CACHE_HOME;
const results = [];
const startedAt = new Date().toISOString();
try {
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), 'twee-contract-'));
    process.env.XDG_CACHE_HOME = join(root, 'cache');
    const { check, ...identity } = item;
    let status = 'pass';
    let detail;
    let watchdog;
    try {
      await Promise.race([
        check(root, item.variant),
        new Promise((_done, reject) => {
          watchdog = setTimeout(() => reject(new Error('case exceeded 15-second evidence limit')), 15000);
        }),
      ]);
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      detail = detail.replaceAll(root, '<fixture>').replaceAll(REPO, '<repo>');
      const setupFailure = /setup failed|exceeded 15-second|ENOENT.*(?:tsc|dist)|ENOSPC|EACCES/.test(detail);
      status = setupFailure ? 'blocked' : 'fail';
    } finally {
      clearTimeout(watchdog);
      rmSync(root, { recursive: true, force: true });
    }
    results.push({ ...identity, status, ...(detail === undefined ? {} : { detail }) });
    console.log(`${status.toUpperCase()} ${item.id}: ${item.variant}${detail ? ` — ${detail.split('\n')[0]}` : ''}`);
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
}

const counts = {
  total: results.length,
  pass: results.filter((item) => item.status === 'pass').length,
  fail: results.filter((item) => item.status === 'fail').length,
  blocked: results.filter((item) => item.status === 'blocked').length,
  failingClasses: new Set(results.filter((item) => item.status === 'fail').map((item) => item.ticket ?? item.id)).size,
};
const report = {
  matrixRevision: MATRIX_REVISION,
  matrixSha256: createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex'),
  productCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  productTrees: Object.fromEntries(
    ['src', 'bin'].map((path) => [
      path,
      execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: REPO, encoding: 'utf8' }).trim(),
    ]),
  ),
  productWorkingTreeChanges: execFileSync('git', ['status', '--porcelain', '--', 'src', 'bin'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim(),
  environment: {
    node: process.version,
    pnpm: execFileSync('pnpm', ['--version'], { cwd: REPO, encoding: 'utf8' }).trim(),
    typescript: JSON.parse(readFileSync(join(REPO, 'node_modules', 'typescript', 'package.json'), 'utf8')).version,
    vite: viteVersion,
    platform: process.platform,
    arch: process.arch,
  },
  startedAt,
  completedAt: new Date().toISOString(),
  counts,
  results,
};
let failed = counts.fail > 0 || counts.blocked > 0;
if (values.baseline) {
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8'));
  const previous = new Map(baseline.results.map((item) => [item.id, item]));
  const present = new Set(results.map((item) => item.id));
  const removed = baseline.results.filter((item) => !present.has(item.id)).map((item) => item.id);
  const changedDefinitions = results
    .filter((item) => {
      const old = previous.get(item.id);
      return old && (old.invariant !== item.invariant || old.variant !== item.variant);
    })
    .map((item) => item.id);
  const transitions = results.map((item) => ({
    id: item.id,
    from: previous.get(item.id)?.status ?? 'unreviewed',
    to: item.status,
  }));
  report.comparison = {
    baselineCommit: baseline.productCommit,
    removed,
    changedDefinitions,
    fixed: transitions.filter((item) => item.from === 'fail' && item.to === 'pass').map((item) => item.id),
    regressed: transitions.filter((item) => item.from === 'pass' && item.to !== 'pass').map((item) => item.id),
    newlyTested: transitions.filter((item) => item.from === 'unreviewed').map((item) => item.id),
    unchangedFailures: transitions.filter((item) => item.from === 'fail' && item.to === 'fail').map((item) => item.id),
    transitions,
  };
  failed =
    removed.length > 0 ||
    changedDefinitions.length > 0 ||
    counts.blocked > 0 ||
    transitions.some((item) => item.to === 'fail' && item.from !== 'fail');
  console.log(
    `Baseline comparison: ${failed ? 'regression or incomplete evidence' : 'no new failures; known failures still listed'}`,
  );
}
if (values.report) write(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(counts));
process.exitCode = failed ? 1 : 0;
