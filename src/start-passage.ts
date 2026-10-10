/**
 * Starting passage validation: the effective start must exist and be a
 * passage that the output actually emits, or the story has nowhere to begin.
 */
import type { Diagnostic, PassageOutputTarget, ReadonlyStory } from './types.js';
import { describeOmission, passageOmission } from './passage-omission.js';

/**
 * Check that `startName` names a passage the `target` output emits.
 * Returns the error diagnostics to report (empty when the start is usable).
 */
export function startPassageDiagnostics(
  story: ReadonlyStory,
  startName: string,
  target: PassageOutputTarget,
): readonly Diagnostic[] {
  const passage = story.passages.find((p) => p.name === startName);
  if (passage === undefined) {
    return [{ level: 'error', message: `Starting passage "${startName}" not found.` }];
  }
  const omission = passageOmission(story, passage, target);
  if (omission === undefined) return [];
  return [
    {
      level: 'error',
      message: `Starting passage "${startName}" ${describeOmission(omission)}, so it is left out of the story data. Choose a story passage.`,
    },
  ];
}

/**
 * Check that the story has a name. Twine 1 reads its name from the StoryTitle passage, so that passage
 * must exist; a Twine 2 story may also take its name from an imported file, but it must have one.
 * Returns the error diagnostics to report (empty when the story is named).
 */
export function storyTitleDiagnostics(story: ReadonlyStory, target: PassageOutputTarget): readonly Diagnostic[] {
  const hasPassage = story.passages.some((p) => p.name === 'StoryTitle');
  if ((target === 'twine1' || story.name === '') && !hasPassage) {
    return [{ level: 'error', message: 'Special passage "StoryTitle" not found.' }];
  }
  if (story.name === '') {
    return [{ level: 'error', message: 'Special passage "StoryTitle" is empty, so the story has no name.' }];
  }
  return [];
}
