import { describe, it, expect } from 'vitest';
import { describeOmission, passageOmission } from '../src/passage-omission.js';
import { createStory } from '../src/story.js';
import type { Passage, PassageOmission } from '../src/types.js';

const passage = (name: string, tags: string[] = []): Passage => ({ name, tags, text: 'x' });

describe('passageOmission', () => {
  it('keeps an ordinary passage in either output', () => {
    const story = createStory();
    expect(passageOmission(story, passage('Start'), 'twine2')).toBeUndefined();
    expect(passageOmission(story, passage('Start'), 'twine1')).toBeUndefined();
  });

  it('leaves StoryTitle and StoryData out of Twine 2 only', () => {
    const story = createStory();
    expect(passageOmission(story, passage('StoryData'), 'twine2')).toEqual({ kind: 'special-name', name: 'StoryData' });
    expect(passageOmission(story, passage('StoryTitle'), 'twine2')).toEqual({
      kind: 'special-name',
      name: 'StoryTitle',
    });
    expect(passageOmission(story, passage('StoryTitle'), 'twine1')).toBeUndefined();
  });

  it('leaves out Twine.private passages in both outputs', () => {
    const story = createStory();
    const hidden = passage('Secret', ['Twine.private']);
    expect(passageOmission(story, hidden, 'twine2')).toEqual({ kind: 'tag', tag: 'Twine.private' });
    expect(passageOmission(story, hidden, 'twine1')).toEqual({ kind: 'tag', tag: 'Twine.private' });
  });

  it('leaves StorySettings out of Twine 2 only while it holds no settings', () => {
    const story = createStory();
    const settings = passage('StorySettings');
    expect(passageOmission(story, settings, 'twine2')).toEqual({ kind: 'empty-story-settings' });
    story.twine1.settings.set('jquery', 'on');
    expect(passageOmission(story, settings, 'twine2')).toBeUndefined();
  });

  it('rejects an unknown output target', () => {
    // @ts-expect-error a target outside the union
    expect(() => passageOmission(createStory(), passage('A'), 'twine3')).toThrow('unhandled passage output target');
  });
});

describe('describeOmission', () => {
  it('words each kind as a predicate', () => {
    expect(describeOmission({ kind: 'special-name', name: 'StoryTitle' })).toBe('is the special "StoryTitle" passage');
    expect(describeOmission({ kind: 'tag', tag: 'Twine.private' })).toBe('is tagged "Twine.private"');
    expect(describeOmission({ kind: 'empty-story-settings' })).toBe('is an empty "StorySettings" passage');
  });

  it('rejects an unknown kind', () => {
    expect(() => describeOmission({ kind: 'other' } as unknown as PassageOmission)).toThrow(
      'unhandled passage omission',
    );
  });
});
