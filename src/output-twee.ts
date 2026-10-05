/**
 * Twee 3/1 decompile output.
 * Ported from storyout.go.
 */
import type { ReadonlyStory, ReadonlyPassage, OutputMode } from './types.js';
import { passageToTwee } from './passage.js';
import { createStory, marshalStoryData, unmarshalStoryData } from './story.js';

/**
 * Serialize the story as Twee. The StoryData passage is written from the story model rather than
 * from its loaded text, so changes made after loading (a start passage override, test mode) are kept.
 * Tweego writes the loaded text; its own normalization makes the two the same for an unchanged story.
 *
 * `addStoryData`: add a StoryData passage when the story has none, so that StoryData fields the
 * compile options set are recorded. Default: false.
 */
export function toTwee(
  story: ReadonlyStory,
  outMode: OutputMode,
  options: { readonly addStoryData?: boolean } = {},
): string {
  return withEffectiveStoryData(story, options.addStoryData ?? false)
    .map((p) => passageToTwee(p, outMode))
    .join('');
}

function withEffectiveStoryData(story: ReadonlyStory, addStoryData: boolean): readonly ReadonlyPassage[] {
  const storyData: ReadonlyPassage = { name: 'StoryData', tags: [], text: marshalStoryData(story) };
  const index = story.passages.findIndex((p) => p.name === 'StoryData');
  if (index !== -1) {
    return story.passages.map((p, i) => (i === index && isStoryDataJSON(p.text) ? { ...p, text: storyData.text } : p));
  }
  if (!addStoryData) return story.passages;
  // Place it where Twine and the HTML decompiler do: first, or right after a leading StoryTitle.
  const at = story.passages[0]?.name === 'StoryTitle' ? 1 : 0;
  return [...story.passages.slice(0, at), storyData, ...story.passages.slice(at)];
}

/** Whether the text loaded as StoryData. Text that did not is kept as written, for the author to fix. */
function isStoryDataJSON(text: string): boolean {
  return unmarshalStoryData(createStory(), text) === null;
}
