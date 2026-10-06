import { describe, it, expect } from 'vitest';
import {
  createStory,
  storyAdd,
  storyGet,
  decodeStoryData,
  unmarshalStorySettings,
  StoryBuilder,
} from '../src/story.js';
import type { Diagnostic, Passage } from '../src/types.js';

const mk = (name: string, text = ''): Passage => ({ name, tags: [], text });

describe('storyGet', () => {
  it('finds a passage by name and reports a missing one', () => {
    const story = createStory();
    storyAdd(story, mk('A', 'a'), []);
    storyAdd(story, mk('B', 'b'), []);
    expect(storyGet(story, 'B')?.text).toBe('b');
    expect(storyGet(story, 'Missing')).toBeUndefined();
  });
});

describe('decodeStoryData with JSON that is not an object', () => {
  it.each(['[1,2]', 'null', '"text"', '42'])('rejects %s', (json) => {
    expect(decodeStoryData(json)).toEqual({ ok: false, reason: 'expected a JSON object' });
  });

  it('reports invalid JSON with its position', () => {
    expect(decodeStoryData('{nope')).toEqual({
      ok: false,
      reason: 'unexpected character "n"; expected a string key or "}" at line 1, column 2',
    });
  });
});

describe('unmarshalStorySettings: malformed entries', () => {
  it('warns about a line without a colon, skips it and keeps the others', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    unmarshalStorySettings(story, 'jquery:on\nno colon here\n\nobfuscate:rot13', diag);
    expect(diag).toEqual([{ level: 'warning', message: 'Malformed "StorySettings" entry; skipping "no colon here".' }]);
    expect(story.twine1.settings.get('jquery')).toBe('on');
    expect(story.twine1.settings.get('obfuscate')).toBe('rot13');
  });
});

describe('StoryBuilder.build', () => {
  it('returns the story holding the added passages', () => {
    const builder = new StoryBuilder();
    builder.add(mk('A', 'a'), []);
    const story = builder.build();
    expect(story).toEqual(builder.build());
    expect(story).not.toBe(builder.build());
    expect(story.passages.map((p) => p.name)).toEqual(['A']);
  });
});
