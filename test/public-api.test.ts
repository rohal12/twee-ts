/**
 * The package's public surface (src/index.ts), so that a change to it is a deliberate one (CLAUDE.md:
 * "public API changes must be intentional"): the runtime exports are listed here, and the types that public
 * signatures use can be named by a consumer (#250 API-5; `pnpm run typecheck` checks this file).
 */
import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';
import type {
  DecompileResult,
  ParseOptions,
  ParseResult,
  RemoteResolveOptions,
  SemVer,
  Story,
  Twine1Metadata,
  Twine2FormatJSON,
  Twine2Metadata,
  TweeTsErrorCode,
} from '../src/index.js';
import { WatchPathError } from '../src/filesystem.js';
import { TweeTsError } from '../src/errors.js';

describe('the public API', () => {
  it('exports exactly these runtime values', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CONFIG_FILENAME',
      'ItemType',
      'StoryBuilder',
      'TweeLexer',
      'TweeTsError',
      'WatchPathError',
      'applyTagAliases',
      'clearCachedFormats',
      'compareVersions',
      'compile',
      'compileIncremental',
      'compileToFile',
      'createIFID',
      'decompileHTML',
      'discoverCachedFormats',
      'discoverFormats',
      'fetchDirectFormat',
      'formatLintReport',
      'generateIFID',
      'getCacheDir',
      'getCacheSize',
      'getFormatSearchDirs',
      'lint',
      'listCachedFormats',
      'loadConfig',
      'loadConfigFile',
      'parseFormatJSON',
      'parseTwee',
      'parseVersion',
      'resolveRemoteFormat',
      'scaffoldConfig',
      'storyInspect',
      'tweeLexer',
      'unknownConfigKeyWarnings',
      'validateConfig',
      'validateIFID',
      'watch',
    ]);
  });

  it('exports the error classes the API throws and reports, so callers can test for them (#250 API-3)', () => {
    expect(api.WatchPathError).toBe(WatchPathError);
    expect(api.TweeTsError).toBe(TweeTsError);
    const error = new api.WatchPathError('story', new Error('EMFILE'));
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.path, error.message]).toEqual(['WatchPathError', 'story', 'Cannot watch story: EMFILE']);
    const code: TweeTsErrorCode = 'FORMAT_UNAVAILABLE';
    expect(new api.TweeTsError('x', [], { code }).code).toBe(code);
  });

  it('names the types its signatures use', () => {
    const version: SemVer | null = api.parseVersion('2.37.3-rc.1');
    expect(version).toEqual({ major: 2, minor: 37, patch: 3, prerelease: ['rc', '1'] });
    const options: ParseOptions = { filename: 'a.tw' };
    const parsed: ParseResult = api.parseTwee(':: A\nx', options);
    expect(parsed.passages.map((p) => p.name)).toEqual(['A']);
    const format: Twine2FormatJSON | null = api.parseFormatJSON(
      'window.storyFormat({name: "F", version: "1.0.0", source: "s"})',
    );
    expect(format?.name).toBe('F');
    const decompiled: DecompileResult = api.decompileHTML('<tw-storydata name="S"></tw-storydata>');
    const story: Story = decompiled.story;
    const metadata: [Twine1Metadata, Twine2Metadata] = [story.twine1, story.twine2];
    expect(metadata[1].zoom).toBe(1);
    const resolve: RemoteResolveOptions = { indices: [], urls: [], useDefaultIndices: false };
    expect(resolve.useDefaultIndices).toBe(false);
  });
});
