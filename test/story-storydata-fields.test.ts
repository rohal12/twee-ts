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

describe('decodeStoryData with repeated fields, as Go decodes them (#306)', () => {
  const IFID = '12345678-1234-4234-8234-123456789ABC';
  const decode = (members: string) => {
    const decoded = decodeStoryData(`{"ifid":"${IFID}",${members}}`);
    if (!decoded.ok) throw new Error('not decoded');
    return decoded;
  };

  it.each([
    ['"start":"First","start":null', 'start', 'First'],
    ['"format":"A","format":null', 'format', 'A'],
    ['"format-version":"1.0.0","format-version":null', 'formatVersion', '1.0.0'],
    ['"zoom":2,"zoom":null', 'zoom', 2],
    ['"start":"A","start":"B"', 'start', 'B'],
  ] as const)('%s leaves the value a later null did not change', (members, key, expected) => {
    expect(decode(members).twine2[key]).toBe(expected);
  });

  it('keeps a valid IFID that a later null repeats', () => {
    const decoded = decodeStoryData(`{"ifid":"${IFID}","ifid":null}`);
    expect(decoded.ok && decoded.ifid).toBe(IFID);
  });

  it('merges a repeated tag-colors object, overwrites its keys and clears it on null', () => {
    expect([...decode('"tag-colors":{"a":"red"},"tag-colors":{"b":"blue"}').twine2.tagColors]).toEqual([
      ['a', 'red'],
      ['b', 'blue'],
    ]);
    expect([...decode('"tag-colors":{"a":"red"},"tag-colors":{}').twine2.tagColors]).toEqual([['a', 'red']]);
    expect([...decode('"tag-colors":{"a":"red"},"tag-colors":{"a":"blue"}').twine2.tagColors]).toEqual([['a', 'blue']]);
    expect([...decode('"tag-colors":{"a":"red"},"tag-colors":null').twine2.tagColors]).toEqual([]);
  });

  it('decodes a repeated options array into the slots of the earlier one', () => {
    expect([...decode('"options":["debug"],"options":[null]').twine2.options.keys()]).toEqual(['debug']);
    expect([...decode('"options":["a","b"],"options":["x"]').twine2.options.keys()]).toEqual(['x']);
    expect([...decode('"options":["a","b"],"options":[null,"y"]').twine2.options.keys()]).toEqual(['a', 'y']);
    expect([...decode('"options":["a"],"options":null').twine2.options.keys()]).toEqual([]);
  });
});
