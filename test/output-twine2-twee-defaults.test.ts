/**
 * Twine 2 HTML output and Twee output called without their optional arguments.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toTwee } from '../src/output-twee.js';
import { toTwine2HTML } from '../src/output-twine2.js';
import { normalizeIFID } from '../src/ifid.js';
import { createStory } from '../src/story.js';
import type { Story, StoryFormatInfo } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

function story(): Story {
  const result = createStory();
  result.name = 'Tale';
  result.ifid = normalizeIFID(IFID);
  return result;
}

describe('toTwine2HTML without options', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-output-twine2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fills the story name and data and injects nothing', () => {
    const filename = join(dir, 'format.js');
    writeFileSync(
      filename,
      `window.storyFormat(${JSON.stringify({ name: 'Custom', version: '1.0.0', source: '<title>{{STORY_NAME}}</title></head>{{STORY_DATA}}' })});`,
    );
    const format: StoryFormatInfo = {
      id: 'custom-1.0.0',
      filename,
      isTwine2: true,
      name: 'Custom',
      version: '1.0.0',
      proofing: false,
    };
    const tale = story();
    tale.passages.push({ name: 'Start', tags: [], text: 'Hello' });

    const html = toTwine2HTML(tale, format, 'Start');

    expect(html).toMatch(/^<title>Tale<\/title><\/head><!-- UUID:/);
    expect(html).toContain('<tw-passagedata');
  });
});

describe('toTwee without options', () => {
  it('writes the passages as they are, with no StoryData added', () => {
    const tale = story();
    tale.passages.push({ name: 'Start', tags: [], text: 'Hello' });

    expect(toTwee(tale, 'twee3')).toBe(':: Start\nHello\n\n\n');
  });

  it('adds StoryData to a story without passages', () => {
    const output = toTwee(story(), 'twee3', { addStoryData: true });

    expect(output).toMatch(/^:: StoryData\n\{/);
    expect(output).toContain(IFID);
  });

  it('adds StoryData after a leading StoryTitle', () => {
    const tale = story();
    tale.passages.push({ name: 'StoryTitle', tags: [], text: 'Tale' }, { name: 'Start', tags: [], text: 'Hello' });

    const names = [...toTwee(tale, 'twee3', { addStoryData: true }).matchAll(/^:: (.*)$/gm)].map((m) => m[1]);

    expect(names).toEqual(['StoryTitle', 'StoryData', 'Start']);
  });
});
