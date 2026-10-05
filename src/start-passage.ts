/**
 * Starting passage validation: the effective start must exist and be a
 * passage that the output actually emits, or the story has nowhere to begin.
 */
import type { Diagnostic, PassageOmission, ReadonlyPassage, ReadonlyStory } from './types.js';
import { twine2PassageOmission } from './output-twine2.js';
import { twine1PassageOmission } from './output-twine1.js';

/** Which output's passage rules decide whether the start passage is emitted. */
export type StartPassageTarget = 'twine1' | 'twine2';

function describeOmission(omission: PassageOmission): string {
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

function omissionFor(
  story: ReadonlyStory,
  passage: ReadonlyPassage,
  target: StartPassageTarget,
): PassageOmission | undefined {
  switch (target) {
    case 'twine2':
      return twine2PassageOmission(story, passage);
    case 'twine1':
      return twine1PassageOmission(passage);
    default: {
      const _exhaustive: never = target;
      throw new Error(`unhandled start passage target: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Check that `startName` names a passage the `target` output emits.
 * Returns the error diagnostics to report (empty when the start is usable).
 */
export function startPassageDiagnostics(
  story: ReadonlyStory,
  startName: string,
  target: StartPassageTarget,
): readonly Diagnostic[] {
  const passage = story.passages.find((p) => p.name === startName);
  if (passage === undefined) {
    return [{ level: 'error', message: `Starting passage "${startName}" not found.` }];
  }
  const omission = omissionFor(story, passage, target);
  if (omission === undefined) return [];
  return [
    {
      level: 'error',
      message: `Starting passage "${startName}" ${describeOmission(omission)}, so it is left out of the story data. Choose a story passage.`,
    },
  ];
}
