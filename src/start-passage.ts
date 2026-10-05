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
