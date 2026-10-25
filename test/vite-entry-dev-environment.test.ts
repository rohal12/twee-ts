/** User plugins see the development command throughout entry bundling (#249 D3). */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { InlineConfig, Plugin } from 'vite';
import { tweeTsPlugin } from '../src/plugins/vite.js';
import {
  buildFiles,
  cleanUp,
  COMPILE,
  makeProject,
  runEntry,
  startServer,
  STORY,
  textOf,
  userScript,
} from './helpers/plugins.js';

afterEach(cleanUp);

describe('the entry user plugin environment command', () => {
  it('keeps one environment identity for selection and hooks across user plugins', async () => {
    const dir = makeProject({ 'story.tw': STORY, 'main.js': 'out.value = IDENTITY;' });
    const environments = new WeakSet<object>();
    const configs = new WeakSet<object>();
    const { url } = await startServer({
      root: dir,
      plugins: [
        {
          name: 'remember-environment',
          applyToEnvironment(environment) {
            environments.add(environment);
            configs.add(environment.config);
            return true;
          },
          buildStart() {
            environments.add(this.environment);
            configs.add(this.environment.config);
          },
        },
        {
          name: 'use-environment',
          transform: {
            filter: { id: /main\.js$/ },
            handler(code) {
              return code.replace(
                'IDENTITY',
                JSON.stringify(environments.has(this.environment) && configs.has(this.environment.config)),
              );
            },
          },
        },
        tweeTsPlugin({
          sources: [join(dir, 'story.tw')],
          entry: join(dir, 'main.js'),
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    expect(runEntry(userScript(await (await fetch(url)).text()))).toEqual({ value: true });
  });

  it('keeps the dev command for user plugins in worker builds too', async () => {
    const dir = makeProject({
      'story.tw': STORY,
      'main.js': 'globalThis.worker = new Worker(new URL("./worker.js", import.meta.url));',
      'worker.js': 'postMessage("WORKER_TOKEN");',
    });
    const commands: string[] = [];
    const { url } = await startServer({
      root: dir,
      worker: {
        plugins: () => [
          {
            name: 'worker-command',
            applyToEnvironment(environment) {
              commands.push(`select:${environment.config.command}`);
              return true;
            },
            transform(code) {
              commands.push(`transform:${this.environment.config.command}`);
              return code;
            },
          },
        ],
      },
      plugins: [
        tweeTsPlugin({
          sources: [join(dir, 'story.tw')],
          entry: join(dir, 'main.js'),
          format: 'test-format-1',
          compileOptions: COMPILE,
        }),
      ],
    });
    expect(await (await fetch(url)).text()).toContain('tw-storydata');
    expect(commands).toContain('select:serve');
    expect(commands).toContain('transform:serve');
    expect(commands.some((value) => value.endsWith(':build'))).toBe(false);
  });

  it.each(['boolean', 'returned plugins'] as const)(
    'selects %s for serve in dev and build in production',
    async (kind) => {
      const dir = makeProject({ 'story.tw': STORY, 'main.js': 'out.marks = ["MARK"];' });
      function selected(command: 'serve' | 'build'): Plugin {
        const transform: Plugin = {
          name: `selected-${command}`,
          transform: {
            filter: { id: /main\.js$/ },
            handler(code) {
              return code.replace('"MARK"', `"${command}", "MARK"`);
            },
          },
        };
        return {
          ...transform,
          applyToEnvironment(environment) {
            if (environment.config.command !== command) return false;
            return kind === 'boolean' ? Promise.resolve(true) : Promise.resolve([Promise.resolve([transform])]);
          },
        };
      }
      const config = (): InlineConfig => ({
        root: dir,
        plugins: [
          selected('serve'),
          selected('build'),
          tweeTsPlugin({
            sources: [join(dir, 'story.tw')],
            entry: join(dir, 'main.js'),
            format: 'test-format-1',
            compileOptions: COMPILE,
          }),
        ],
      });
      const { url } = await startServer(config());
      expect(runEntry(userScript(await (await fetch(url)).text()))).toEqual({ marks: ['serve', 'MARK'] });
      expect(runEntry(userScript(textOf((await buildFiles(config())).get('index.html'))))).toEqual({
        marks: ['build', 'MARK'],
      });
    },
  );

  it.each(['top-level', 'environment-returned'] as const)(
    'preserves the command in %s plugin hook contexts',
    async (kind) => {
      const dir = makeProject({
        'story.tw': STORY,
        'main.js': 'import value from "virtual:command"; out.value = value; out.transform = TOKEN;',
      });
      const seen: string[] = [];
      const user: Plugin = {
        name: 'command-context',
        buildStart() {
          seen.push(`start:${this.environment.config.command}`);
        },
        resolveId(id) {
          return id === 'virtual:command' ? `\0command:${this.environment.config.command}` : undefined;
        },
        load(id) {
          return id.startsWith('\0command:')
            ? `export default ${JSON.stringify(this.environment.config.command)};`
            : undefined;
        },
        transform: {
          order: 'pre',
          filter: { id: /main\.js$/ },
          handler(code) {
            return code.replace(
              'TOKEN',
              JSON.stringify({
                command: this.environment.config.command,
                top: this.environment.getTopLevelConfig().command,
              }),
            );
          },
        },
        renderChunk() {
          seen.push(`render:${this.environment.config.command}`);
        },
        generateBundle() {
          seen.push(`generate:${this.environment.config.command}`);
        },
      };
      const config = (): InlineConfig => ({
        root: dir,
        plugins: [
          kind === 'top-level'
            ? user
            : {
                name: 'return-command-context',
                applyToEnvironment: () => Promise.resolve([Promise.resolve(user)]),
              },
          tweeTsPlugin({
            sources: [join(dir, 'story.tw')],
            entry: join(dir, 'main.js'),
            format: 'test-format-1',
            compileOptions: COMPILE,
          }),
        ],
      });
      const { url } = await startServer(config());
      expect(runEntry(userScript(await (await fetch(url)).text()))).toEqual({
        value: 'serve',
        transform: { command: 'serve', top: 'serve' },
      });
      expect(seen).toContain('render:serve');
      expect(seen).toContain('generate:serve');
      expect(seen.some((value) => value.endsWith(':build'))).toBe(false);
      expect(runEntry(userScript(textOf((await buildFiles(config())).get('index.html'))))).toEqual({
        value: 'build',
        transform: { command: 'build', top: 'build' },
      });
      expect(seen).toContain('render:build');
    },
  );
});
