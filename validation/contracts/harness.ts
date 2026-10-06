/**
 * What the contract cases share: declaring a group's cases from the matrix, a fresh fixture
 * folder and format cache per case, story and story-format fixtures, a loopback HTTP server and
 * a Vite development server. The cases import `@rohal12/twee-ts` as a user does, and
 * vitest.contracts.config.ts points that at the build in dist/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { InlineConfig, PluginOption } from 'vite';
import { describe, expect, it } from 'vitest';
import type { CompileOptions, CompileResult, InlineSource } from '@rohal12/twee-ts';
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';
import type { TweeTsVitePluginOptions } from '@rohal12/twee-ts/vite';
import { caseId, ISSUES, MATRIX } from './cases.js';
import type { GroupName, Variant } from './cases.js';

export const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

/** One case's check; `root` is an empty folder of its own, and the format cache lives inside it. */
type Check = (root: string) => Promise<void>;

/** A case may take this long: the Vite cases start a build and a development server. */
const CASE_TIMEOUT = 60_000;

/**
 * Declares the cases of `group`, one test per variant, named `ID: variant`. `checks` has exactly
 * one check per variant of the matrix, so a case cannot be left out or added here alone.
 */
export function defineContracts<G extends GroupName>(
  group: G,
  checks: Readonly<Record<Variant<G>, Check>>,
  options: { readonly skip?: (variant: Variant<G>) => string | undefined } = {},
): void {
  const { invariant, issue, variants } = MATRIX[group];
  const owner = issue === undefined ? '' : ` (${ISSUES}${String(issue)})`;
  // The matrix's `as const` makes each group's variants a tuple of literals; reading them through
  // the generic `G` widens that to the union of every group's variants, so narrow it back.
  const own = (variant: string): variant is Variant<G> => Object.hasOwn(checks, variant);
  describe(`${group}: ${invariant}${owner}`, () => {
    variants.forEach((variant: string, index) => {
      if (!own(variant)) throw new Error(`${group}: no check for the variant "${variant}"`);
      const reason = options.skip?.(variant);
      const name = `${caseId(group, index)}: ${variant}`;
      if (reason !== undefined) {
        it.skip(`${name} (${reason})`, () => undefined);
        return;
      }
      it(name, { timeout: CASE_TIMEOUT }, async () => {
        const root = mkdtempSync(join(tmpdir(), 'twee-contract-'));
        // The format cache, and an empty home, so no installed story format answers.
        const isolated = {
          XDG_CACHE_HOME: join(root, 'cache'),
          HOME: join(root, 'home'),
          USERPROFILE: join(root, 'home'),
        };
        const saved = Object.keys(isolated).map((key) => [key, process.env[key]] as const);
        Object.assign(process.env, isolated);
        try {
          await checks[variant](root);
        } finally {
          for (const [key, value] of saved) {
            if (value === undefined) Reflect.deleteProperty(process.env, key);
            else process.env[key] = value;
          }
          rmSync(root, { recursive: true, force: true });
        }
      });
    });
  });
}

/** Writes `text` to `path`, making its folders, and returns the path. */
export function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A story with StoryData, a title and a Start passage of `text`, then `extra`. */
export function story(text = 'Hello', metadata: Readonly<Record<string, unknown>> = {}, extra = ''): string {
  return `:: StoryData\n${JSON.stringify({ ifid: IFID, ...metadata })}\n\n:: StoryTitle\nValidation Story\n\n:: Start [location]\n${text}\n${extra}`;
}

export function inline(content = story()): InlineSource {
  return { filename: 'story.tw', content };
}

/** A story format's format.js. */
export function formatText(name = 'ValidationFixture', version = '1.0.0', source = page()): string {
  return `window.storyFormat(${JSON.stringify({ name, version, source })});`;
}

/** A story format's page template: `prefix`, then a document whose head opens with `head`. */
export function page(prefix = '', head = '<head>'): string {
  return `${prefix}<!doctype html><html>${head}<title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>`;
}

/** The compile options of a build that finds only the format written here, with `source` as its page. */
export function localFormat(
  root: string,
  source = page(),
): {
  readonly formatId: string;
  readonly options: Pick<CompileOptions, 'formatPaths' | 'useTweegoPath' | 'noRemote'>;
} {
  const formats = join(root, 'formats');
  write(join(formats, 'validation-fixture-1', 'format.js'), formatText('ValidationFixture', '1.0.0', source));
  return {
    formatId: 'validation-fixture-1',
    options: { formatPaths: [formats], useTweegoPath: false, noRemote: true },
  };
}

/** The diagnostics of `result` that are errors. */
export function errorsOf(result: CompileResult): string[] {
  return result.diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
}

export function expectNoErrors(result: CompileResult): void {
  expect(errorsOf(result)).toEqual([]);
}

/** The text of the passage named `name`. */
export function passageText(result: CompileResult, name: string): string | undefined {
  return result.story.passages.find((p) => p.name === name)?.text;
}

/** How a process ended, and what it printed. */
export interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command` to its end; a process that cannot start rejects. */
export function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      fail(new Error(`${command} could not start`, { cause: error }));
    });
    child.on('close', (status) => {
      done({ status, stdout, stderr });
    });
  });
}

/** Runs `action` with the origin of a loopback HTTP server that answers with `handler`. */
export async function serve<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  action: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createHttpServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = addressOf(server.address());
    return await action(`http://127.0.0.1:${String(port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }
}

function addressOf(address: string | AddressInfo | null): AddressInfo {
  if (address === null || typeof address === 'string') throw new Error('the server is not listening on a port');
  return address;
}

/**
 * The page the plugin's development server serves at `/`, with `config` merged into the server's
 * configuration and `plugins` before the twee-ts plugin.
 */
export async function devHtml(
  root: string,
  pluginOptions: TweeTsVitePluginOptions,
  config: InlineConfig = {},
  plugins: readonly PluginOption[] = [],
): Promise<string> {
  const errors: string[] = [];
  const server = await createViteServer({
    configFile: false,
    root,
    logLevel: 'silent',
    ...config,
    customLogger: {
      info: () => undefined,
      warn: () => undefined,
      warnOnce: () => undefined,
      clearScreen: () => undefined,
      error: (message) => {
        errors.push(message);
      },
      hasErrorLogged: () => false,
      hasWarned: false,
    },
    plugins: [...plugins, tweeTsPlugin(pluginOptions)],
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const { port } = addressOf(server.httpServer?.address() ?? null);
    const html = await (await fetch(`http://127.0.0.1:${String(port)}`)).text();
    expect(errors).toEqual([]);
    expect(html, 'the development server served its waiting page').not.toContain('The story has not compiled yet.');
    return html;
  } finally {
    await server.close();
  }
}
