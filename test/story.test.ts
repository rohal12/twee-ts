import { describe, it, expect } from 'vitest';
import {
  createStory,
  storyHas,
  storyGet,
  storyAdd,
  marshalStoryData,
  unmarshalStoryData,
  unmarshalStorySettings,
} from '../src/story.js';
import type { Diagnostic, Passage } from '../src/types.js';

function mkPassage(name: string, text = '', tags: string[] = []): Passage {
  return { name, tags, text };
}

describe('Story', () => {
  it('creates an empty story', () => {
    const story = createStory();
    expect(story.passages).toHaveLength(0);
    expect(story.name).toBe('');
    expect(story.ifid).toBe('');
    expect(story.twine2.zoom).toBe(1);
  });

  it('adds passages', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('Test', 'Content'), diag);
    expect(story.passages).toHaveLength(1);
    expect(storyHas(story, 'Test')).toBe(true);
    expect(storyGet(story, 'Test')?.text).toBe('Content');
  });

  it('warns on duplicate passages', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('Test', 'First'), diag);
    storyAdd(story, mkPassage('Test', 'Second'), diag);
    expect(story.passages).toHaveLength(1);
    expect(storyGet(story, 'Test')?.text).toBe('Second');
    expect(diag.some((d) => d.message.includes('duplicate'))).toBe(true);
  });

  it('processes StoryTitle', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('StoryTitle', '  My Story  '), diag);
    expect(story.name).toBe('My Story');
    expect(storyGet(story, 'StoryTitle')?.text).toBe('My Story');
  });

  it('processes StoryData', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(
      story,
      mkPassage(
        'StoryData',
        JSON.stringify({
          ifid: 'd674c58c-defa-4f70-b7a2-27742230c0fc',
          format: 'SugarCube',
          'format-version': '2.37.3',
          start: 'Begin',
        }),
      ),
      diag,
    );
    expect(story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(story.twine2.format).toBe('SugarCube');
    expect(story.twine2.formatVersion).toBe('2.37.3');
    expect(story.twine2.start).toBe('Begin');
  });

  it('warns on StoryIncludes', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('StoryIncludes', 'file1.tw\nfile2.tw'), diag);
    expect(diag.some((d) => d.message.includes('StoryIncludes'))).toBe(true);
  });
});

describe('marshalStoryData', () => {
  it('roundtrips through marshal/unmarshal', () => {
    const story = createStory();
    story.ifid = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
    story.twine2.format = 'SugarCube';
    story.twine2.formatVersion = '2.37.3';
    story.twine2.start = 'Begin';

    const json = marshalStoryData(story);
    const story2 = createStory();
    const err = unmarshalStoryData(story2, json);
    expect(err).toBeNull();
    expect(story2.ifid).toBe(story.ifid);
    expect(story2.twine2.format).toBe(story.twine2.format);
    expect(story2.twine2.start).toBe(story.twine2.start);
  });
});

describe('unmarshalStorySettings', () => {
  it('parses key:value pairs', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    unmarshalStorySettings(story, 'obfuscate:rot13\njquery:on', diag);
    expect(story.twine1.settings.get('obfuscate')).toBe('rot13');
    expect(story.twine1.settings.get('jquery')).toBe('on');
  });

  it('warns about obsolete ifid and zoom entries', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    unmarshalStorySettings(story, 'ifid:D674C58C-DEFA-4F70-B7A2-27742230C0FC\nzoom:2', diag);
    expect(diag.some((d) => d.message.includes('obsolete'))).toBe(true);
    expect(story.legacyIFID).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });
});
