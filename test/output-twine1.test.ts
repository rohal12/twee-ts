/**
 * Twine 1 HTML output: format components, the settings that pull in libraries, and where the IFID comment goes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toTwine1HTML } from '../src/output-twine1.js';
import { normalizeIFID } from '../src/ifid.js';
import { createStory } from '../src/story.js';
import type { Story, StoryFormatInfo } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'twee-ts-output-twine1-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Twine 1 format named `custom-1` whose header is `header`; shared components go in `dir`. */
function format(header: string): StoryFormatInfo {
  mkdirSync(join(dir, 'custom-1'), { recursive: true });
  const filename = join(dir, 'custom-1', 'header.html');
  writeFileSync(filename, header);
  return { id: 'custom-1', filename, isTwine2: false, name: 'custom-1', version: '', proofing: false };
}

function story(settings: readonly (readonly [string, string])[] = [], ifid = IFID): Story {
  const result = createStory();
  result.ifid = normalizeIFID(ifid);
  result.passages.push({ name: 'Start', tags: [], text: 'Hello' });
  for (const [key, value] of settings) result.twine1.settings.set(key, value);
  return result;
}

describe('toTwine1HTML library components', () => {
  const HEADER =
    '<html><head>"JQUERY"|"MODERNIZR"|"USER_LIB"</head><body><div id="storeArea">"STORY"</div></body></html>';

  it('leaves jQuery and Modernizr out unless the story settings turn them on', () => {
    const html = toTwine1HTML(story(), format(HEADER), 'Start');

    expect(html).toContain('"JQUERY"|"MODERNIZR"');
  });

  it('inlines jQuery and Modernizr from the formats folder when the settings turn them on', () => {
    writeFileSync(join(dir, 'jquery.js'), '/* jquery */');
    writeFileSync(join(dir, 'modernizr.js'), '/* modernizr */');
    const html = toTwine1HTML(
      story([
        ['jquery', 'on'],
        ['modernizr', 'on'],
      ]),
      format(HEADER),
      'Start',
    );

    expect(html).toContain('/* jquery */|/* modernizr */');
  });

  it('throws when a library the settings ask for is missing', () => {
    expect(() => toTwine1HTML(story([['jquery', 'on']]), format(HEADER), 'Start')).toThrow(
      /Required format component not found: .*jquery\.js/,
    );
    expect(() => toTwine1HTML(story([['modernizr', 'on']]), format(HEADER), 'Start')).toThrow(
      /Required format component not found: .*modernizr\.js/,
    );
    // A TweeTsError with a code, as every error a build stops with (#250 API-3).
    expect(() => toTwine1HTML(story([['jquery', 'on']]), format(HEADER), 'Start')).toThrow(
      expect.objectContaining({ name: 'TweeTsError', code: 'FORMAT_UNAVAILABLE', cause: expect.any(Error) }),
    );
  });

  it('keeps the placeholder of a missing user library, which is optional', () => {
    const html = toTwine1HTML(story(), format(HEADER), 'Start');

    expect(html).toContain('"USER_LIB"');
  });

  it('inlines the user library of the format when it exists', () => {
    const header = format(HEADER);
    writeFileSync(join(dir, 'custom-1', 'userlib.js'), '/* userlib */');

    expect(toTwine1HTML(story(), header, 'Start')).toContain('|/* userlib */<');
  });
});

describe('toTwine1HTML optional components (#399)', () => {
  // Each optional component: the header that asks for it, its file, and what the output has without it.
  const components = [
    {
      file: 'userlib.js',
      header: '<html><head>"USER_LIB"</head><body><div id="storeArea">"STORY"</div></body></html>',
      without: '"USER_LIB"',
    },
    { file: 'footer.html', header: '<html><head></head><body><div id="storeArea">', without: '</div>\n</body>' },
  ] as const;
  // Only nothing at the path selects the fallback, as Tweego's os.IsNotExist (a dangling link reads as ENOENT).
  const absent: readonly (readonly [string, (path: string) => void])[] = [
    ['missing', () => {}],
    [
      'a dangling link',
      (path) => {
        symlinkSync(join(dir, 'gone'), path);
      },
    ],
  ];
  const unusable: readonly (readonly [string, (path: string) => void, RegExp])[] = [
    [
      'a folder',
      (path) => {
        mkdirSync(path);
      },
      /EISDIR/,
    ],
    [
      'undecodable',
      (path) => {
        writeFileSync(path, Buffer.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]));
      },
      /UTF-32/,
    ],
    // ELOOP on POSIX; Windows has its own code for a link to itself.
    [
      'a link loop',
      (path) => {
        symlinkSync(path, path);
      },
      process.platform === 'win32' ? /./ : /ELOOP/,
    ],
  ];

  for (const { file, header, without } of components) {
    for (const [what, make] of absent) {
      it(`does without ${file} when it is ${what}`, () => {
        const info = format(header);
        make(join(dir, 'custom-1', file));
        expect(toTwine1HTML(story(), info, 'Start')).toContain(without);
      });
    }
    for (const [what, make, cause] of unusable) {
      it(`stops when ${file} is ${what}, rather than silently leave it out`, () => {
        const info = format(header);
        make(join(dir, 'custom-1', file));
        const render = (): string => toTwine1HTML(story(), info, 'Start');
        expect(render).toThrow(new RegExp(`^Format component cannot be read: .*${file.replace('.', '\\.')}: `));
        expect(render).toThrow(cause);
        expect(render).toThrow(expect.objectContaining({ name: 'TweeTsError', code: 'FORMAT_UNAVAILABLE' }));
      });
    }
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      `stops when ${file} can't be read (EACCES), as Tweego does`,
      () => {
        const info = format(header);
        const path = join(dir, 'custom-1', file);
        writeFileSync(path, 'x');
        chmodSync(path, 0o000);
        expect(() => toTwine1HTML(story(), info, 'Start')).toThrow(/EACCES/);
      },
    );
  }
});

describe('toTwine1HTML IFID comment', () => {
  it('goes before a store-area div', () => {
    const html = toTwine1HTML(story(), format('<body><div id="store-area">"STORY"</div></body>'), 'Start');

    expect(html).toContain(`<!-- UUID://${IFID}// --><div id="store-area">`);
  });

  it('is left out when the story has no IFID', () => {
    const html = toTwine1HTML(story([], ''), format('<body><div id="storeArea">"STORY"</div></body>'), 'Start');

    expect(html).not.toContain('UUID:');
    expect(html).toContain('<div id="storeArea"><div tiddler="Start"');
  });
});
