/**
 * Which passages an output leaves out of its passage elements, and how to say why.
 * The rules themselves live with each output renderer; this module picks one by target.
 */
import type { PassageOmission, PassageOutputTarget, ReadonlyPassage, ReadonlyStory } from './types.js';
import { twine2PassageOmission } from './output-twine2.js';
import { twine1PassageOmission } from './output-twine1.js';

/**
 * Why the `target` output leaves `passage` out of its passage elements, or `undefined` when it
 * emits the passage (and so a link or the start can name it).
 */
export function passageOmission(
  story: ReadonlyStory,
  passage: ReadonlyPassage,
  target: PassageOutputTarget,
): PassageOmission | undefined {
  switch (target) {
    case 'twine2':
      return twine2PassageOmission(story, passage);
    case 'twine1':
      return twine1PassageOmission(passage);
    default: {
      const _exhaustive: never = target;
      throw new Error(`unhandled passage output target: ${String(_exhaustive)}`);
    }
  }
}

/** Why a passage is left out, as a predicate: `Passage "X" ${describeOmission(o)}`. */
export function describeOmission(omission: PassageOmission): string {
  switch (omission.kind) {
    case 'special-name':
      return `is the special "${omission.name}" passage`;
    case 'tag':
      return `is tagged "${omission.tag}"`;
    case 'empty-story-settings':
      return 'is an empty "StorySettings" passage';
    default: {
      const _exhaustive: never = omission;
      throw new Error(`unhandled passage omission: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
