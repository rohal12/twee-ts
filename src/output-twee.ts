/**
 * Twee 3/1 decompile output.
 * Ported from storyout.go.
 */
import type { ReadonlyStory, OutputMode } from './types.js';
import { passageToTwee } from './passage.js';

export function toTwee(story: ReadonlyStory, outMode: OutputMode): string {
  let data = '';
  for (const p of story.passages) {
    data += passageToTwee(p, outMode);
  }
  return data;
}
