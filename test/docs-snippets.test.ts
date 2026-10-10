/**
 * The documentation's examples are executable: every code block in README.md and docs/ is checked.
 *
 * - TypeScript and JavaScript blocks are type-checked against the package as it is built (dist/,
 *   reached through the package.json exports, as a user's project reaches it), with `strict`,
 *   `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` on, and then run against a fixture
 *   project, offline (fetch fails), with HOME and the format cache in a temporary folder.
 * - A block that shows a type (`<!-- docs-test: mirror … -->`) must declare the same properties
 *   as the exported type of that name, each assignable to it.
 * - Shell blocks run every `twee-ts` / `npx @rohal12/twee-ts` command with the built CLI against
 *   the fixture project and check its exit status (0 unless the directive says `exit=N`); with
 *   `output`, the output lines the block shows must be what the command prints.
 * - JSON blocks are twee-ts config files: valid, with no unknown keys. Twee blocks parse without
 *   errors. A `format-js` block is decoded as a story format.
 *
 * A block that is deliberately not run or not checked has a directive saying so, with its reason;
 * UNTESTED lists them, so a new one is a visible change. See test/helpers/docs.ts for the syntax.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allCodeBlocks, blockId, REPO, shellWords } from './helpers/docs.js';
import type { CodeBlock } from './helpers/docs.js';
import { parseTwee } from '../src/parser.js';
import { parseFormatJSON } from '../src/format-decode.js';
import { unknownConfigKeyWarnings, validateConfig } from '../src/config.js';

const PACKAGE = '@rohal12/twee-ts';
/** Each example runs node (several times for a shell block); slow CI machines need more than the default. */
const RUN_TIMEOUT = 120_000;
const BLOCKS = allCodeBlocks();

/** The directive words and keys the tests understand. */
const KNOWN_WORDS = new Set(['skip', 'no-run', 'mirror', 'output', 'format-js', 'json-output', 'not-config']);
const KNOWN_KEYS = new Set(['exit', 'fixture', 'from', 'package', 'file']);

const CODE_LANGS = new Set(['typescript', 'ts', 'javascript', 'js']);
const SHELL_LANGS = new Set(['sh', 'bash', 'shell']);
/** Blocks that are output, file trees or other text, never run. */
const TEXT_LANGS = new Set(['', 'text', 'html']);

/**
 * The blocks that are not run or not checked, by document and heading, with the reason their
 * directive gives. A block is listed here when its directive says `skip` or `no-run`.
 */
const UNTESTED: readonly string[] = [
  'docs/api.md § Remote Formats: no-run — downloads story formats from the network',
  'docs/migrating-to-2.md § Config paths are relative to the config file: skip — a 1.x config, shown for comparison',
  'docs/migrating-to-2.md § StoryBuilder: skip — 1.x code, which no longer compiles',
  'docs/migrating-to-2.md § Options are checked when the plugin is created: skip — 1.x options, which 2.0 rejects',
  'docs/story-format-packages.md § Usage by story authors: no-run — a story script, which runs in the browser inside the story',
  'docs/story-format-packages.md § Linking types to source: skip — an excerpt of types/index.d.ts above, with a tag added',
];

const isCode = (b: CodeBlock): boolean => CODE_LANGS.has(b.lang) && !b.directive.words.has('format-js');
const isShell = (b: CodeBlock): boolean => SHELL_LANGS.has(b.lang);
/** A JSON block that is not a twee-ts config: a described package's file, JSON output, or marked so. */
const notConfig = (b: CodeBlock): boolean =>
  b.directive.words.has('not-config') || b.directive.words.has('json-output') || b.directive.values.has('file');
const skipped = (b: CodeBlock): boolean => b.directive.words.has('skip');

// --- The fixture project ---

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

function formatJs(name: string, version: string): string {
  const source = '<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>';
  return `window.storyFormat(${JSON.stringify({ name, version, proofing: false, source })});\n`;
}

/** The files of each fixture project, by name. Every one has the story formats and the config. */
const FIXTURES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  story: {
    'src/StoryData.tw': `:: StoryData\n{\n\t"ifid": "${IFID}",\n\t"format": "SugarCube",\n\t"format-version": "2.37.3",\n\t"start": "Start"\n}\n`,
    'src/StoryTitle.tw': ':: StoryTitle\nMy Story\n',
    'src/Start.tw': ':: Start\nYou wake up. [[Look around|Kitchen]]\n',
    'src/story/Kitchen.tw': ':: Kitchen\nA kitchen. [[Start]]\n',
    'head.html': '<meta name="description" content="A story">\n',
    'src/extra.js': 'window.extra = true;\n',
    'src/analytics.js': 'window.analytics = true;\n',
  },
  broken: {
    'src/StoryTitle.tw': ':: StoryTitle\nMy Story\n',
    'src/StoryData.tw': `:: StoryData\n{\n\t"ifid": "${IFID}"\n}\n`,
    'src/Start.tw': ':: Start\nYou wake up.\n\n:: Kitchen [food\nA kitchen.\n',
  },
  lint: {
    'src/StoryTitle.tw': ':: StoryTitle\nMy Story\n',
    'src/StoryData.tw': `:: StoryData\n{\n\t"ifid": "${IFID}",\n\t"format": "SugarCube",\n\t"format-version": "2.37.3"\n}\n`,
    'src/Start.tw': ':: Start\nYou wake up. [[Kitchen]]\n',
    'src/Kitchen.tw':
      ':: Kitchen\nA kitchen. [[Pantry]] [[Notes]] [[Ending1]] [[Ending2]]\n\n:: Notes [Twine.private]\nTo do.\n',
    'src/Endings.tw':
      ':: Ending1\nThe end.\n\n:: Ending2\nAnother end.\n\n:: UnusedRoom\nNobody comes here. [[Start]]\n',
  },
};

const COMMON_FILES: Readonly<Record<string, string>> = {
  'twee-ts.config.json': '{\n  "sources": ["src/"],\n  "output": "story.html"\n}\n',
  'configs/production.json': '{\n  "sources": ["../src/"],\n  "output": "../story.html"\n}\n',
  'storyformats/sugarcube-2/format.js': formatJs('SugarCube', '2.37.3'),
  'storyformats/harlowe-3/format.js': formatJs('Harlowe', '3.3.9'),
};

interface Workspace {
  readonly root: string;
  /** The consumer project the snippets are compiled in, with the built package installed. */
  readonly consumer: string;
  /** The built CLI. */
  readonly cli: string;
  /** A module, run with --import, that makes fetch fail: the examples run offline. */
  readonly offline: string;
  /** The type-check output of the snippets. */
  typecheck: string;
  /** The snippet of each code block, by block id. */
  readonly snippets: Map<string, Snippet>;
  fixtureCount: number;
}

let ws: Workspace;
/** The workspace folder, for clean-up even when setting it up failed. */
let workspaceRoot = '';

/** The keys of a JSON object, sorted; none when the text is not one. */
function jsonKeys(text: string): string[] {
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
}

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A fresh copy of a fixture project, with its own home folder and format cache. */
function fixture(name = 'story'): { readonly dir: string; readonly env: NodeJS.ProcessEnv } {
  const files = FIXTURES[name];
  if (files === undefined) throw new Error(`unknown fixture "${name}"`);
  const base = join(ws.root, `run-${ws.fixtureCount++}`);
  const dir = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  writeFiles(dir, { ...COMMON_FILES, ...files });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, 'cache') };
  delete env['TWEEGO_PATH'];
  delete env['NODE_OPTIONS'];
  return { dir, env };
}

/** Links (a junction on Windows) a package from the repository's node_modules into the consumer. */
function linkPackage(name: string): void {
  const target = join(REPO, 'node_modules', name);
  const path = join(ws.consumer, 'node_modules', name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Where a block's code goes in the consumer project, as written by compileSnippets(). */
interface Snippet {
  readonly block: CodeBlock;
  /** The file under snippets/, with forward slashes. */
  readonly path: string;
  readonly source: string;
  /** The generated lines before the block's code, for error positions. */
  readonly prefixLines: number;
}

const isJs = (b: CodeBlock): boolean => b.lang === 'javascript' || b.lang === 'js';

/**
 * Where a block goes: a block of a package the docs describe (`package=… file=…`) at that file of
 * the package under snippets/packages/ (a `.d.ts` as `.ts`, so that it is checked too), any other
 * block in a file of its own.
 */
function snippetPath(block: CodeBlock): string {
  const pkg = block.directive.values.get('package');
  const file = block.directive.values.get('file');
  if (pkg !== undefined && file !== undefined) return `packages/${pkg}/${file.replace(/\.d\.ts$/, '.ts')}`;
  return `${block.doc.replace(/[/.]/g, '_')}_L${block.line}.${isJs(block) ? 'js' : 'ts'}`;
}

/** The module each exported type name comes from: the package's main entry point, or a plugin's. */
function exportedTypeModules(): Map<string, string> {
  const modules = new Map<string, string>();
  const entries = [
    ['src/plugins/vite.ts', `${PACKAGE}/vite`],
    ['src/plugins/rollup.ts', `${PACKAGE}/rollup`],
    ['src/index.ts', PACKAGE],
  ] as const;
  for (const [file, specifier] of entries) {
    const text = readFileSync(join(REPO, file), 'utf8');
    const names = [
      ...[...text.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) =>
        (m[1] ?? '').split(',').map(
          (name) =>
            name
              .trim()
              .split(/\s+as\s+/)
              .pop() ?? '',
        ),
      ),
      ...[...text.matchAll(/export (?:interface|type|class) (\w+)/g)].map((m) => m[1] ?? ''),
    ];
    for (const name of names.filter((n) => n !== '')) modules.set(name, specifier);
  }
  return modules;
}

/**
 * A mirror block's check: the block's declarations in a namespace, and for each one a check that
 * it has the keys of the exported type of the same name, that the two are assignable to each other
 * and that the same properties are read-only.
 */
function mirrorSnippet(block: CodeBlock, exported: ReadonlyMap<string, string>): Snippet {
  const from = block.directive.values.get('from') ?? PACKAGE;
  const declared = [...block.code.matchAll(/^(?:export )?(?:interface|type) (\w+)/gm)].map((m) => m[1] ?? '');
  const used = new Set([...block.code.matchAll(/\b([A-Z]\w*)\b/g)].map((m) => m[1] ?? ''));
  const imports = [...used].flatMap((name) => {
    const module = exported.get(name);
    return module === undefined || declared.includes(name) ? [] : [`import type { ${name} } from '${module}';`];
  });
  const prefix = [
    `import type * as Real from '${from}';`,
    ...imports,
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
    'type Defined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };',
    'type ReadonlyKeys<T> = { [K in keyof T]-?: Equal<{ [P in K]: T[P] }, { -readonly [P in K]: T[P] }> extends true ? never : K }[keyof T];',
    'declare namespace Doc {',
  ];
  const checks = declared.flatMap((name) => [
    `const keys_${name}: Equal<keyof Doc.${name}, keyof Real.${name}> = true;`,
    `const assignable_${name} = (value: Doc.${name}): Real.${name} => value;`,
    // The shipped type must also fit the documented one (a documented \`T[]\` is not the shipped \`readonly T[]\`),
    // and the same properties must be read-only.
    `const shipped_${name} = (value: Defined<Real.${name}>): Defined<Doc.${name}> => value;`,
    `const readonly_${name}: Equal<ReadonlyKeys<Doc.${name}>, ReadonlyKeys<Real.${name}>> = true;`,
  ]);
  return {
    block,
    path: snippetPath(block),
    source: `${[...prefix, block.code, '}', ...checks].join('\n')}\nexport {};\n`,
    prefixLines: prefix.length,
  };
}

function setUpWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'twee-ts-docs-'));
  workspaceRoot = root;
  const consumer = join(root, 'consumer');
  const pkg = join(consumer, 'node_modules', '@rohal12', 'twee-ts');
  mkdirSync(pkg, { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(pkg, 'package.json'));
  cpSync(join(REPO, 'schemas'), join(pkg, 'schemas'), { recursive: true });
  const build = spawnSync(
    process.execPath,
    [join(REPO, 'node_modules', 'tsdown', 'dist', 'run.mjs'), '--out-dir', join(pkg, 'dist')],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`tsdown failed\n${build.stdout}\n${build.stderr}`);
  const offline = join(root, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = () => Promise.reject(new TypeError('fetch failed: the documentation tests run offline'));\n",
  );
  return {
    root,
    consumer,
    cli: join(pkg, 'dist', 'bin', 'twee-ts.js'),
    offline,
    typecheck: '',
    snippets: new Map(),
    fixtureCount: 0,
  };
}

/**
 * The tsconfig `paths` of the packages the docs describe: each package's types entry, from the
 * `package.json` block the docs show for it.
 */
function describedPackagePaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const block of BLOCKS.filter((b) => b.lang === 'json' && b.directive.values.get('file') === 'package.json')) {
    const pkg = block.directive.values.get('package') ?? '';
    const types = /"types":\s*"\.\/([^"]+)"/.exec(block.code)?.[1];
    if (types !== undefined) paths[pkg] = [`./snippets/packages/${pkg}/${types.replace(/\.d\.ts$/, '.ts')}`];
  }
  return paths;
}

/**
 * The source of an ordinary block: the block as a module. A described package's declaration files
 * are written as `.ts`, so their references to each other are too.
 */
function plainSource(block: CodeBlock): string {
  const code = block.directive.values.has('package') ? block.code.replace(/\.d\.ts(["'])/g, '.ts$1') : block.code;
  return `${code}\nexport {};\n`;
}

/** Writes every TypeScript and JavaScript block into the consumer project and type-checks them. */
function compileSnippets(): void {
  for (const name of ['vite', 'rollup', '@types/node']) linkPackage(name);
  writeFileSync(join(ws.consumer, 'package.json'), '{ "private": true, "type": "module" }\n');
  writeFileSync(
    join(ws.consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        // DOM for the story scripts the format packaging guide shows.
        lib: ['ES2024', 'DOM'],
        types: ['node'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        allowJs: true,
        checkJs: true,
        skipLibCheck: true,
        rootDir: 'snippets',
        outDir: 'out',
        paths: describedPackagePaths(),
      },
      include: ['snippets'],
    }),
  );
  const exported = exportedTypeModules();
  for (const block of BLOCKS.filter((b) => isCode(b) && !skipped(b))) {
    const snippet = block.directive.words.has('mirror')
      ? mirrorSnippet(block, exported)
      : { block, path: snippetPath(block), source: plainSource(block), prefixLines: 0 };
    mkdirSync(dirname(join(ws.consumer, 'snippets', snippet.path)), { recursive: true });
    writeFileSync(join(ws.consumer, 'snippets', snippet.path), snippet.source);
    ws.snippets.set(blockId(block), snippet);
  }
  const tsc = spawnSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], {
    cwd: ws.consumer,
    encoding: 'utf8',
  });
  ws.typecheck = `${tsc.stdout}${tsc.stderr}`.trim();
  // Files of a described package that are not code (its format.js) go next to its compiled code.
  for (const block of BLOCKS.filter((b) => b.directive.words.has('format-js') && b.directive.values.has('file'))) {
    const out = join(ws.consumer, 'out', snippetPath(block));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, block.code);
  }
}

/** The compiled JavaScript of a snippet. */
function compiledPath(snippet: Snippet): string {
  return join(ws.consumer, 'out', snippet.path.replace(/\.ts$/, '.js'));
}

/** Where a type error in a snippet is in the documentation. */
function locateErrors(output: string): string {
  const byPath = new Map([...ws.snippets.values()].map((s) => [s.path, s] as const));
  return output.replace(/snippets[\\/]([^(:]+)\((\d+),(\d+)\)/g, (match, file: string, line: string) => {
    const snippet = byPath.get(file.replace(/\\/g, '/'));
    if (snippet === undefined) return match;
    // The code starts on the line after the fence.
    return `${snippet.block.doc}:${snippet.block.line + Number(line) - snippet.prefixLines} (${match})`;
  });
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs node with `args` in `cwd`, offline. A process that does not end by itself (watch mode) is
 * stopped once `until` holds for what it has printed to standard error.
 */
function runNode(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  until?: (stderr: string) => boolean,
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(ws.offline).href, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    let stopped = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: node ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (until !== undefined && !stopped && until(stderr)) {
        stopped = true;
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      // A watch process that was stopped ran until stopped: its status is the one the docs show (0).
      resolvePromise({ status: stopped ? 0 : status, stdout, stderr });
    });
  });
}

/** The CLI commands of a shell block: `twee-ts …` or `npx @rohal12/twee-ts …`, with a `$ ` prompt or without. */
function cliCommands(block: CodeBlock): { readonly args: string[]; readonly line: string }[] {
  const lines = block.code.split('\n');
  const transcript = lines.some((l) => l.startsWith('$ '));
  return (
    lines
      .filter((l) => (transcript ? l.startsWith('$ ') : l.trim() !== '' && !l.trimStart().startsWith('#')))
      .map((l) => (transcript ? l.slice(2) : l))
      // Other commands (npm install, echo $?) are the reader's, not the CLI's.
      .filter((line) => /^(?:twee-ts|npx @rohal12\/twee-ts)(?:\s|$)/.test(line))
      .map((line) => ({ line, words: shellWords(line) }))
      .flatMap(({ line, words }) => {
        if (words[0] === 'twee-ts') return [{ args: words.slice(1), line }];
        if (words[0] === 'npx' && words[1] === PACKAGE) return [{ args: words.slice(2), line }];
        return [];
      })
  );
}

/** The output lines a transcript block shows for the CLI: not its commands, nor the `echo $?` status. */
function shownOutput(block: CodeBlock): string[] {
  return block.code.split('\n').filter((l) => !l.startsWith('$ ') && l.trim() !== '' && !/^\d+$/.test(l));
}

/**
 * The examples run against the package built with tsdown, which needs Node 22.18+ (or 24.11+). CI runs
 * them on the latest Node 24.
 */
const CAN_BUILD = ((): boolean => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major >= 26;
})();

beforeAll(() => {
  if (!CAN_BUILD) return;
  ws = setUpWorkspace();
  compileSnippets();
}, 180_000);

afterAll(() => {
  if (workspaceRoot !== '') rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('documentation code blocks', () => {
  it('have a known language and well-formed directives', () => {
    const problems = BLOCKS.flatMap((b) => {
      const known = CODE_LANGS.has(b.lang) || SHELL_LANGS.has(b.lang) || TEXT_LANGS.has(b.lang);
      const issues = [
        ...(known || ['json', 'twee'].includes(b.lang) ? [] : [`unknown language "${b.lang}"`]),
        ...[...b.directive.words].filter((w) => !KNOWN_WORDS.has(w)).map((w) => `unknown directive word "${w}"`),
        ...[...b.directive.values.keys()].filter((k) => !KNOWN_KEYS.has(k)).map((k) => `unknown directive key "${k}"`),
        ...((skipped(b) || b.directive.words.has('no-run')) && b.directive.reason === ''
          ? ['a skip or no-run directive needs a reason']
          : []),
      ];
      return issues.map((issue) => `${blockId(b)}: ${issue}`);
    });
    expect(problems).toEqual([]);
  });

  it('that are not run or not checked are the ones listed, each with its reason', () => {
    const untested = BLOCKS.filter((b) => skipped(b) || b.directive.words.has('no-run')).map(
      (b) => `${b.doc} § ${b.heading}: ${[...b.directive.words].join(' ')} — ${b.directive.reason}`,
    );
    expect(untested).toEqual(UNTESTED);
  });
});

describe.skipIf(!CAN_BUILD)('TypeScript and JavaScript examples', () => {
  it('type-check against the built package (strict, exactOptionalPropertyTypes)', () => {
    expect(locateErrors(ws.typecheck)).toBe('');
  });

  const runnable = BLOCKS.filter(
    (b) => isCode(b) && !skipped(b) && !b.directive.words.has('no-run') && !b.directive.words.has('mirror'),
  );
  it.each(runnable.map((b) => [blockId(b), b] as const))(
    '%s runs against the fixture project',
    async (_id, block) => {
      const snippet = ws.snippets.get(blockId(block));
      const compiled = snippet === undefined ? '' : compiledPath(snippet);
      expect(existsSync(compiled)).toBe(true);
      const { dir, env } = fixture(block.directive.values.get('fixture'));
      const result = await runNode([compiled], dir, env);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
    },
    RUN_TIMEOUT,
  );
});

describe.skipIf(!CAN_BUILD)('shell examples', () => {
  const shell = BLOCKS.filter((b) => isShell(b) && !skipped(b) && cliCommands(b).length > 0);
  it.each(shell.map((b) => [blockId(b), b] as const))(
    '%s runs with the documented exit status',
    async (_id, block) => {
      const { dir, env } = fixture(block.directive.values.get('fixture'));
      const expected = Number(block.directive.values.get('exit') ?? '0');
      const outputs: string[] = [];
      for (const { args, line } of cliCommands(block)) {
        const watch = args.includes('-w') || args.includes('--watch');
        // Watch mode logs `Built: …` after each build: the build ran, and the watcher is still running.
        // With the output shown, it runs until it has printed all of it.
        const until = !watch
          ? undefined
          : block.directive.words.has('output')
            ? (stderr: string) => shownOutput(block).every((l) => stderr.includes(l))
            : (stderr: string) => /^Built: /m.test(stderr);
        const result = await runNode([ws.cli, ...args], dir, env, until);
        outputs.push(...`${result.stdout}${result.stderr}`.split('\n').filter((l) => l.trim() !== ''));
        expect({ line, status: result.status }, `${line}\n${result.stdout}\n${result.stderr}`).toEqual({
          line,
          status: expected,
        });
      }
      // Without `output`, the block shows output the fixture project doesn't give (or none).
      const shown = shownOutput(block);
      expect(block.directive.words.has('output') ? outputs : shown).toEqual(shown);
    },
    RUN_TIMEOUT,
  );
});

describe('other examples', () => {
  it('JSON blocks are valid twee-ts configs without unknown keys', () => {
    const configs = BLOCKS.filter((b) => b.lang === 'json' && !skipped(b) && !notConfig(b));
    expect(configs.length).toBeGreaterThan(0);
    const problems = configs.flatMap((b) => {
      const data: unknown = JSON.parse(b.code);
      return [...validateConfig(data), ...unknownConfigKeyWarnings(data)].map((p) => `${blockId(b)}: ${p}`);
    });
    expect(problems).toEqual([]);
  });

  it('JSON blocks that are not configs are valid JSON', () => {
    const others = BLOCKS.filter((b) => b.lang === 'json' && !skipped(b) && notConfig(b));
    for (const b of others) expect((): unknown => JSON.parse(b.code), blockId(b)).not.toThrow();
  });

  it.skipIf(!CAN_BUILD)(
    'a JSON output example has the keys --json writes',
    async () => {
      const examples = BLOCKS.filter((b) => b.directive.words.has('json-output'));
      expect(examples.length).toBeGreaterThan(0);
      const { dir, env } = fixture();
      const result = await runNode([ws.cli, '--json', '-o', '-', 'src/'], dir, env);
      const actual = jsonKeys(result.stdout);
      for (const b of examples) expect(jsonKeys(b.code), blockId(b)).toEqual(actual);
    },
    RUN_TIMEOUT,
  );

  it('Twee blocks parse without errors', () => {
    const twee = BLOCKS.filter((b) => b.lang === 'twee' && !skipped(b));
    expect(twee.length).toBeGreaterThan(0);
    const problems = twee.flatMap((b) =>
      parseTwee(b.code)
        .diagnostics.filter((d) => d.level === 'error')
        .map((d) => `${blockId(b)}: ${d.message}`),
    );
    expect(problems).toEqual([]);
  });

  it('format.js examples are story formats twee-ts can read', () => {
    const formats = BLOCKS.filter((b) => b.directive.words.has('format-js'));
    expect(formats.length).toBeGreaterThan(0);
    for (const b of formats) expect(parseFormatJSON(b.code), blockId(b)).not.toBeNull();
  });
});
