import { describe, it, expect } from 'vitest';
import { storyInspect } from '../src/inspect.js';
import { createStory } from '../src/story.js';

describe('storyInspect with passages of the same name', () => {
  it('lets a link reach a name when any one passage of it is emitted', () => {
    const story = createStory();
    story.passages.push(
      { name: 'Start', tags: [], text: '[[Room]]' },
      { name: 'Room', tags: ['Twine.private'], text: 'left out' },
      { name: 'Room', tags: [], text: 'emitted' },
    );

    expect(storyInspect(story, { target: 'twine2' }).brokenLinks).toEqual([]);
  });

  it('reports a link to a name when every passage of it is left out', () => {
    const story = createStory();
    story.passages.push(
      { name: 'Start', tags: [], text: '[[Room]]' },
      { name: 'Room', tags: ['Twine.private'], text: 'left out' },
      { name: 'Room', tags: ['Twine.private'], text: 'also left out' },
    );

    expect(storyInspect(story, { target: 'twine2' }).brokenLinks).toEqual([
      { from: 'Start', to: 'Room', omission: { kind: 'tag', tag: 'Twine.private' } },
    ]);
  });
});
