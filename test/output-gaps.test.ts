/**
 * Small behaviors of the Twee and Twine 2 writers, the HTML decompiler, link reading and inspection that no other
 * test exercises.
 */
import { describe, it, expect } from 'vitest';
import { decompileHTML } from '../src/html-parser.js';
import { storyInspect } from '../src/inspect.js';
import { readSquareBracketedMarkup } from '../src/link-markup.js';
import { toTwee } from '../src/output-twee.js';
import { toTwine2Archive } from '../src/output-twine2.js';
import { normalizeIFID } from '../src/ifid.js';
import { createStory } from '../src/story.js';
import type { Diagnostic } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

describe('readSquareBracketedMarkup image setters', () => {
  it('reads the setter after an image link', () => {
    const text = '[img[pic.png][Room][$x to 1]]';

    expect(readSquareBracketedMarkup(text, 0)).toEqual({ type: 'image', link: 'Room', end: text.length });
  });
});

describe('readSquareBracketedMarkup image link at the end of the text', () => {
  it('rejects an image link component that runs to the end without closing', () => {
    expect(readSquareBracketedMarkup('[img[pic.png][Room', 0)).toBeUndefined();
    expect(readSquareBracketedMarkup('[img[pic.png][Room][$x to "open]]', 0)).toBeUndefined();
  });
});

describe('decompileHTML passage elements', () => {
  const wrap = (children: string, attributes = ''): string =>
    `<tw-storydata name="S" ifid="${IFID}" ${attributes}>${children}</tw-storydata>`;

  it('reads a passage without a pid, which cannot be the start passage', () => {
    const { story, diagnostics } = decompileHTML(
      wrap('<tw-passagedata name="Start">Hi</tw-passagedata>', 'startnode="1"'),
    );

    expect(diagnostics).toEqual([]);
    expect(story.passages.map((p) => p.name)).toContain('Start');
    expect(story.twine2.start).toBe('');
  });

  it('reads only the text of a passage, not a comment inside it', () => {
    const { story } = decompileHTML(
      wrap('<tw-passagedata pid="1" name="Start">Hi<!-- note --> there</tw-passagedata>'),
    );

    expect(story.passages.find((p) => p.name === 'Start')?.text).toBe('Hi there');
  });
});

describe('toTwee passage names that cannot be written back', () => {
  it('warns about an empty name', () => {
    const story = createStory();
    story.passages.push({ name: '', tags: [], text: 'Hello' });
    const diagnostics: Diagnostic[] = [];

    toTwee(story, 'twee3', { diagnostics });

    expect(diagnostics.map((d) => d.message)).toEqual([
      'Passage "" cannot be written as Twee that reads back the same: its name is empty.',
    ]);
  });
});

describe('toTwine2Archive options', () => {
  it('lists only the story options that are on', () => {
    const story = createStory();
    story.ifid = normalizeIFID(IFID);
    story.twine2.options.set('hidden', true);
    story.twine2.options.set('debug', false);

    const output = toTwine2Archive(story, 'Start');

    expect(output).toContain('options="hidden"');
    expect(output).not.toContain('debug');
  });
});

describe('storyInspect reads nobr passages as SugarCube does', () => {
  it('drops the line breaks around the text of a nobr passage before reading its links', () => {
    const story = createStory();
    story.passages.push(
      { name: 'Start', tags: ['nobr'], text: '\n\n[[Go to\nKitchen]]\n\n' },
      { name: 'Kitchen', tags: [], text: 'Text.' },
    );

    const map = storyInspect(story);

    expect(map.links.get('Start')).toEqual(['Go to Kitchen']);
    expect(map.brokenLinks).toEqual([{ from: 'Start', to: 'Go to Kitchen' }]);
  });
});
