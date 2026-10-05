/**
 * Twee 3/1 decompile output.
 * Ported from storyout.go.
 */
import type { Diagnostic, ReadonlyStory, ReadonlyPassage, OutputMode } from './types.js';
import { passageToTwee } from './passage.js';
import { createStory, marshalStoryData, unmarshalStoryData } from './story.js';

/**
 * Serialize the story as Twee. The StoryData passage is written from the story model rather than
 * from its loaded text, so changes made after loading (a start passage override, test mode) are kept.
 * Tweego writes the loaded text; its own normalization makes the two the same for an unchanged story.
 *
 * Twee cannot write every passage so that it reads back the same (see `tweeRoundTrip()`); `diagnostics`
 * receives a warning for each passage that will not. Tweego writes the same Twee without one.
 *
 * `addStoryData`: add a StoryData passage when the story has none, so that StoryData fields the
 * compile options set are recorded. Default: false.
 */
export function toTwee(
  story: ReadonlyStory,
  outMode: OutputMode,
  options: { readonly addStoryData?: boolean; readonly diagnostics?: Diagnostic[] } = {},
): string {
  const written = withEffectiveStoryData(story, options.addStoryData ?? false).map((p) => tweeRoundTrip(p, outMode));
  options.diagnostics?.push(...written.flatMap(({ diagnostics }) => diagnostics));
  return written.map(({ passage }) => passageToTwee(passage, outMode)).join('');
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

/** A passage as it is written to Twee, and the warnings about what will not read back the same. */
interface WrittenPassage {
  readonly passage: ReadonlyPassage;
  readonly diagnostics: readonly Diagnostic[];
}

/** Characters Twee 3 escapes in names and tags, and Twee 1 cannot write there at all. */
const TWEE1_UNWRITABLE = /[[\]{}\\]/;

/**
 * Check that Twee reads `p` back as written, and say what it will not. Twee has no way to escape passage text,
 * and its parser trims names and splits tags at whitespace, so these do not survive:
 *
 * - a text line that starts with `::`, which reads as a new passage header. In stylesheet and script passages such
 *   a line is indented by one space, which keeps the CSS or JavaScript working (only a template literal or a
 *   string continued across lines, in either, would see the space); the warning says so. Other passages' text is
 *   written as it is.
 * - a name that is empty, has leading or trailing whitespace, or holds a line break;
 * - a tag that is empty or holds whitespace;
 * - in Twee 1, which escapes nothing, a name or tag holding `[`, `]`, `{`, `}` or `\`.
 */
function tweeRoundTrip(p: ReadonlyPassage, outMode: OutputMode): WrittenPassage {
  const label = `Passage ${JSON.stringify(p.name)}`;
  const diagnostics: Diagnostic[] = [];
  const warn = (problem: string): void => {
    diagnostics.push({
      level: 'warning',
      message: `${label} cannot be written as Twee that reads back the same: ${problem}.`,
    });
  };

  if (p.name.trim() === '') warn('its name is empty');
  else if (p.name.trim() !== p.name) warn('its name has leading or trailing whitespace, which Twee drops');
  if (/[\r\n]/.test(p.name)) warn('its name has a line break, which ends a Twee passage header');
  if (outMode === 'twee1' && TWEE1_UNWRITABLE.test(p.name)) {
    warn('its name has "[", "]", "{", "}" or "\\", which Twee 1 cannot escape');
  }

  for (const tag of p.tags) {
    if (tag === '' || /\s/.test(tag)) {
      warn(`its tag ${JSON.stringify(tag)} is empty or has whitespace, which splits tags in Twee`);
    }
    if (outMode === 'twee1' && TWEE1_UNWRITABLE.test(tag)) {
      warn(`its tag ${JSON.stringify(tag)} has "[", "]", "{", "}" or "\\", which Twee 1 cannot escape`);
    }
  }

  // Twee source is read with CRLF and CR line endings turned into LF, so a CR breaks a line too.
  const lines = p.text.split(/(\r\n?|\n)/);
  const headerLines = lines.flatMap((line, i) => (i % 2 === 0 && line.startsWith('::') ? [i / 2 + 1] : []));
  if (headerLines.length === 0) return { passage: p, diagnostics };

  const where = `${headerLines.length === 1 ? 'line' : 'lines'} ${headerLines.join(', ')} of its text start${headerLines.length === 1 ? 's' : ''} with "::", which Twee reads as a passage header`;
  if (!p.tags.some((tag) => tag === 'stylesheet' || tag === 'script')) {
    warn(where);
    return { passage: p, diagnostics };
  }
  diagnostics.push({
    level: 'warning',
    message: `${label}: ${where}; ${headerLines.length === 1 ? 'it was' : 'they were'} written indented by one space.`,
  });
  const text = lines.map((line, i) => (i % 2 === 0 && line.startsWith('::') ? ` ${line}` : line)).join('');
  return { passage: { ...p, text }, diagnostics };
}
