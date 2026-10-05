import { describe, it, expect } from 'vitest';
import { createStory, marshalStoryData, unmarshalStoryData, unmarshalStorySettings } from '../src/story.js';
import type { Diagnostic } from '../src/types.js';

describe('marshalStoryData options', () => {
  it('lists only the options that are switched on', () => {
    const story = createStory();
    story.twine2.options.set('debug', true);
    story.twine2.options.set('hidden', false);
    const data = JSON.parse(marshalStoryData(story)) as { options?: string[] };
    expect(data.options).toEqual(['debug']);
  });

  it('leaves out the options field when every option is off', () => {
    const story = createStory();
    story.twine2.options.set('hidden', false);
    expect(JSON.parse(marshalStoryData(story))).not.toHaveProperty('options');
  });
});

describe('unmarshalStoryData with wrongly typed members', () => {
  it('keeps the string options and ignores the others', () => {
    const story = createStory();
    expect(unmarshalStoryData(story, '{"options":["debug",3,null,{"a":1}]}')).toBeNull();
    expect([...story.twine2.options.keys()]).toEqual(['debug']);
  });

  it('keeps the string tag colors and ignores the others', () => {
    const story = createStory();
    expect(unmarshalStoryData(story, '{"tag-colors":{"a":"red","b":5,"c":null,"d":["x"]}}')).toBeNull();
    expect([...story.twine2.tagColors]).toEqual([['a', 'red']]);
  });

  it('reports the parser message for invalid JSON', () => {
    const message = unmarshalStoryData(createStory(), '{not json');
    expect(message).toMatch(/^Cannot unmarshal "StoryData"; /);
  });
});

describe('unmarshalStorySettings ifid', () => {
  it('records a valid legacy IFID', () => {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    unmarshalStorySettings(story, 'ifid:D674C58C-DEFA-4F70-B7A2-27742230C0FC', diagnostics);
    expect(story.legacyIFID).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('does not record an invalid legacy IFID', () => {
    const story = createStory();
    const before = story.legacyIFID;
    unmarshalStorySettings(story, 'ifid:not-an-ifid', []);
    expect(story.legacyIFID).toBe(before);
  });
});
