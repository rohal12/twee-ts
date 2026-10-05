import { describe, it, expect } from 'vitest';
import {
  createStory,
  storyAdd,
  storyGet,
  storyIndex,
  unmarshalStoryData,
  unmarshalStorySettings,
  StoryBuilder,
} from '../src/story.js';
import type { Diagnostic, Passage } from '../src/types.js';

const mk = (name: string, text = ''): Passage => ({ name, tags: [], text });

describe('storyGet and storyIndex', () => {
  it('find a passage by name and report a missing one', () => {
    const story = createStory();
    storyAdd(story, mk('A', 'a'), []);
    storyAdd(story, mk('B', 'b'), []);
    expect(storyGet(story, 'B')?.text).toBe('b');
    expect(storyIndex(story, 'B')).toBe(1);
    expect(storyGet(story, 'Missing')).toBeUndefined();
    expect(storyIndex(story, 'Missing')).toBe(-1);
  });
});

describe('unmarshalStoryData with JSON that is not an object', () => {
  it.each(['[1,2]', 'null', '"text"', '42'])('rejects %s and leaves the story alone', (json) => {
    const story = createStory();
    story.twine2.format = 'Kept';
    expect(unmarshalStoryData(story, json)).toContain('expected a JSON object');
    expect(story.twine2.format).toBe('Kept');
  });

  it('reports invalid JSON', () => {
    expect(unmarshalStoryData(createStory(), '{nope')).toContain('Cannot unmarshal "StoryData"');
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
    expect(story).toBe(builder.story);
    expect(story.passages.map((p) => p.name)).toEqual(['A']);
  });
});
