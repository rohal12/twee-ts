/**
 * A Vite older than the plugin supports fails at once, with a TweeTsError (`INVALID_OPTIONS`) that names twee-ts and
 * the Vite version, not with what an older Vite makes of a config it can't read (#368).
 */
import { describe, it, expect, vi } from 'vitest';
import type * as Vite from 'vite';
import { TweeTsError } from '../src/compiler.js';
import { checkViteVersion } from '../src/plugins/options.js';

const installed = vi.hoisted(() => ({ version: '8.3.4' }));

vi.mock('vite', async (importOriginal) => {
  const original = await importOriginal<typeof Vite>();
  return {
    ...original,
    get version(): string {
      return installed.version;
    },
  };
});

const { tweeTsPlugin } = await import('../src/plugins/vite.js');

const OPTIONS = { sources: ['story'] };

describe('the supported Vite versions', () => {
  it.each(['8.0.0', '8.0.0-beta.1', '8.3.4', '9.0.0', '10.2.0', 'v8.1.0', 'custom-build'])(
    'accepts Vite %s',
    (version) => {
      expect(() => {
        checkViteVersion(version);
      }).not.toThrow();
    },
  );

  it.each(['7.3.7', '7.99.99', '6.0.0', '5.4.12', '5', '0.1.0'])(
    'refuses Vite %s, naming twee-ts and the version',
    (version) => {
      const error = (() => {
        try {
          checkViteVersion(version);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(TweeTsError);
      expect(error).toMatchObject({
        code: 'INVALID_OPTIONS',
        message: expect.stringMatching(
          new RegExp(`^twee-ts vite plugin: Vite ${version} is not supported.*Vite 8 or newer`),
        ),
      });
    },
  );
});

describe('the Vite plugin under the installed Vite', () => {
  it('is created under a supported Vite', () => {
    installed.version = '8.3.4';
    expect(tweeTsPlugin(OPTIONS)).toMatchObject({ name: 'twee-ts' });
  });

  it('refuses to be created under Vite 7, before it reads the options', () => {
    installed.version = '7.3.7';
    expect(() => tweeTsPlugin({ ...OPTIONS, unknownOption: 1 } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTIONS', message: expect.stringContaining('Vite 7.3.7') }),
    );
    installed.version = '8.3.4';
  });
});
