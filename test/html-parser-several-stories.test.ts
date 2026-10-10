/**
 * HTML that holds several stories (a Twine 2 library archive, files joined together) is read as a story format and
 * Tweego read it, the first story only; the stories left out are reported (#379).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile } from '../src/compiler.js';
import { decompileHTML } from '../src/html-parser.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

const twine2 = (name: string): string =>
  `<tw-storydata name="${name}" startnode="1" ifid="${IFID}" hidden>` +
  `<tw-passagedata pid="1" name="Start ${name}">Hi</tw-passagedata></tw-storydata>`;
const twine1 = (passage: string, id = 'storeArea'): string =>
  `<div id="${id}"><div tiddler="${passage}" tags="">Hi</div></div>`;
const emptyStoreArea = '<div id="store-area" hidden></div>';
const inTemplate = (html: string): string => `<template>${html}</template>`;

describe('HTML with several stories', () => {
  it.each([
    ['one Twine 2 story', twine2('One'), 'One', undefined],
    ['two Twine 2 stories', twine2('One') + twine2('Two'), 'One', 'The HTML holds 2 stories; only "One" is read.'],
    [
      'three Twine 2 stories',
      twine2('One') + twine2('Two') + twine2('Three'),
      'One',
      'The HTML holds 3 stories; only "One" is read.',
    ],
    ['a Twine 2 story and an empty store area', emptyStoreArea + twine2('One'), 'One', undefined],
    [
      'a Twine 2 story and a Twine 1 one',
      twine1('Start') + twine2('One'),
      'One',
      'The HTML holds 2 stories; only "One" is read.',
    ],
    ['a second story in template content', twine2('One') + inTemplate(twine2('Two')), 'One', undefined],
    ['one Twine 1 story', twine1('Start'), '', undefined],
    [
      'two Twine 1 stories',
      twine1('Start') + twine1('Other', 'store-area'),
      '',
      'The HTML holds 2 stories; only one of them is read.',
    ],
    [
      'an empty Twine 1 store area before a full one',
      '<div id="storeArea"></div>' + twine1('Start'),
      '',
      'The HTML holds 2 stories; only one of them is read.',
    ],
  ])('%s', (_, body, name, warning) => {
    const { story, diagnostics } = decompileHTML(`<body>${body}</body>`);
    expect(story.name).toBe(name);
    expect(diagnostics.filter((d) => d.message.startsWith('The HTML holds'))).toEqual(
      warning === undefined ? [] : [{ level: 'warning', message: warning }],
    );
  });

  it('names the Twine 1 story read by its StoryTitle', () => {
    const html = `<body><div id="storeArea"><div tiddler="StoryTitle">Old</div></div>${twine1('Start')}</body>`;
    const { diagnostics } = decompileHTML(html);
    expect(diagnostics).toEqual([{ level: 'warning', message: 'The HTML holds 2 stories; only "Old" is read.' }]);
  });

  it('reports it when compile() loads such a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twee-ts-several-stories-'));
    try {
      const file = join(dir, 'library.html');
      writeFileSync(file, `<body>${twine2('One')}${twine2('Two')}</body>`);
      const result = await compile({ sources: [file], outputMode: 'twee3' });
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warning', message: 'The HTML holds 2 stories; only "One" is read.' }),
      );
      expect(result.output).toContain(':: Start One');
      expect(result.output).not.toContain('Start Two');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
