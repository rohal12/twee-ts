/**
 * Twine 1 ROT13 obfuscation (`obfuscate:rot13` in StorySettings), as Twine 1.4 writes it and its engine reads it.
 */
import type { ReadonlyPassage } from './types.js';
import { createStory, unmarshalStorySettings } from './story.js';

/**
 * Whether the StorySettings tiddlers among `passages` (those written to, or read from, a Twine 1 store area) turn
 * on ROT13 obfuscation, read the way the engine reads them: `obfuscate:rot13`, in any letter case.
 */
export function isRot13Obfuscated(passages: readonly Pick<ReadonlyPassage, 'name' | 'text'>[]): boolean {
  const settings = createStory();
  for (const p of passages) {
    // Diagnostics are dropped here; they are reported where the passage is added to a story.
    if (p.name === 'StorySettings') unmarshalStorySettings(settings, p.text, []);
  }
  return settings.twine1.settings.get('obfuscate') === 'rot13';
}
