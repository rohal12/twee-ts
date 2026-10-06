import { describe, it, expect } from 'vitest';
import { createStory, decodeStoryData, marshalStoryData, unmarshalStorySettings } from '../src/story.js';
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

describe('decodeStoryData with wrongly typed members', () => {
  it('keeps the string options and reports the others (null reads as empty, as in Go)', () => {
    const decoded = decodeStoryData('{"options":["debug",3,null,{"a":1}]}');
    expect(decoded.ok && [...decoded.twine2.options.keys()]).toEqual(['debug', '']);
    expect(decoded.ok && decoded.issues.map((i) => [i.kind, i.message])).toEqual([
      ['type', '$.options[1] must be a string, not a number (3)'],
      ['type', '$.options[3] must be a string, not an object'],
    ]);
  });

  it('keeps the string tag colors and reports the others', () => {
    const decoded = decodeStoryData('{"tag-colors":{"a":"red","b":5,"c":null,"d":["x"]}}');
    expect(decoded.ok && [...decoded.twine2.tagColors]).toEqual([
      ['a', 'red'],
      ['c', ''],
    ]);
    expect(decoded.ok && decoded.issues.map((i) => i.message)).toEqual([
      '$["tag-colors"].b must be a string, not a number (5)',
      '$["tag-colors"].d must be a string, not an array',
    ]);
  });

  it('reports the parser message for invalid JSON', () => {
    expect(decodeStoryData('{not json')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^unexpected character/),
    });
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
