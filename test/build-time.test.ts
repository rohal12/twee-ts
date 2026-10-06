/**
 * The build time stamps of Twine 1 output: one time per build, which SOURCE_DATE_EPOCH sets, so two builds
 * of the same sources give the same bytes (a test comparing two CLI runs no longer straddles a minute).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildTime } from '../src/build-time.js';
import { compile } from '../src/compiler.js';

const STORY = [
  ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
  ...Array.from({ length: 30 }, (_, i) => `:: P${i}\nText ${i}`),
].join('\n\n');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('buildTime', () => {
  it.each([
    ['0', '1970-01-01T00:00:00.000Z'],
    ['1700000000', '2023-11-14T22:13:20.000Z'],
    ['01700000000', '2023-11-14T22:13:20.000Z'],
  ])('reads SOURCE_DATE_EPOCH %j as %s', (epoch, iso) => {
    expect(buildTime({ SOURCE_DATE_EPOCH: epoch }).toISOString()).toBe(iso);
  });

  it('is now without SOURCE_DATE_EPOCH, or with an empty one', () => {
    vi.useFakeTimers({ now: new Date('2030-05-06T07:08:09Z') });
    expect(buildTime({}).toISOString()).toBe('2030-05-06T07:08:09.000Z');
    expect(buildTime({ SOURCE_DATE_EPOCH: '' }).toISOString()).toBe('2030-05-06T07:08:09.000Z');
  });

  it.each(['-1', '1.5', '1e9', ' 1', 'now', '99999999999999999999', '9007199254740991'])(
    'rejects SOURCE_DATE_EPOCH %j',
    (epoch) => {
      expect(() => buildTime({ SOURCE_DATE_EPOCH: epoch })).toThrow(
        expect.objectContaining({ name: 'TweeTsError', code: 'INVALID_OPTIONS' }),
      );
    },
  );
});

describe('Twine 1 archive time stamps', () => {
  const archive = async (): Promise<string> =>
    (await compile({ sources: [{ filename: 'a.tw', content: STORY }], outputMode: 'twine1-archive' })).output;

  it('stamps every tiddler of one build with the same time, even across a minute boundary', async () => {
    vi.useFakeTimers({ now: new Date('2030-05-06T07:08:59.999Z'), shouldAdvanceTime: true, advanceTimeDelta: 5 });
    const created = new Set([...(await archive()).matchAll(/created="(\d+)"/g)].map((m) => m[1]));
    expect(created.size).toBe(1);
  });

  it('gives the same bytes for two builds under SOURCE_DATE_EPOCH', async () => {
    vi.stubEnv('SOURCE_DATE_EPOCH', '1700000000');
    const first = await archive();
    vi.useFakeTimers({ now: new Date('2031-01-01T00:00:00Z') });
    expect(await archive()).toBe(first);
    expect(first).toContain('created="202311142213"');
  });

  it('fails the build for a SOURCE_DATE_EPOCH it cannot read, whatever the output', async () => {
    vi.stubEnv('SOURCE_DATE_EPOCH', 'yesterday');
    await expect(compile({ sources: [{ filename: 'a.tw', content: STORY }], outputMode: 'twee3' })).rejects.toThrow(
      'SOURCE_DATE_EPOCH must be a whole number of seconds',
    );
  });
});
