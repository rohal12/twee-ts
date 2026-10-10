/**
 * Twee 3/1 decompile output.
 * Ported from storyout.go.
 */
import type { Diagnostic, ReadonlyStory, ReadonlyPassage, OutputMode, Passage } from './types.js';
import { metadataForOutput, passageToTwee } from './passage.js';
import { decodeStoryData, marshalStoryData } from './story.js';
import { parseTwee } from './parser.js';
import { ownRecord } from './json-decode.js';
import { isHeaderLine, sourceLines, splitTweeFields, trimTweeSpace } from './twee-syntax.js';
import { pushAll } from './util.js';

/**
 * Serialize the story as Twee. The StoryData passage is written from the story model rather than
 * from its loaded text, so changes made after loading (a start passage override, test mode) are kept.
 * Tweego writes the loaded text; its own normalization makes the two the same for an unchanged story.
 *
 * Every passage is checked by reading what is written for it back with the Twee reader (`parseTwee`, with its
 * default options), so the check and the reader cannot disagree. `diagnostics` receives a warning for each
 * passage that does not read back the same, saying what changes. The white space around passage text is not
 * compared: Twee readers trim it (Tweego always does). Twee 1 has no metadata, so it is left out, with one
 * warning. Tweego writes the same Twee without warnings.
 *
 * `addStoryData`: add a StoryData passage when the story has none, so that StoryData fields the
 * compile options set are recorded. Default: false.
 */
export function toTwee(
  story: ReadonlyStory,
  outMode: OutputMode,
  options: { readonly addStoryData?: boolean; readonly diagnostics?: Diagnostic[] } = {},
): string {
  const passages = withEffectiveStoryData(story, options.addStoryData ?? false);
  const written = passages.map((p) => tweeRoundTrip(p, outMode));
  pushAll(
    options.diagnostics,
    written.flatMap(({ diagnostics }) => diagnostics),
  );
  if (outMode === 'twee1' && options.diagnostics) pushAll(options.diagnostics, twee1MetadataWarning(passages));
  return written.map(({ twee }) => twee).join('');
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

/**
 * Whether the text loaded as StoryData. Text that did not is kept as written, for the author to fix; the story
 * has none of its metadata, and reading the text back gives none again.
 */
function isStoryDataJSON(text: string): boolean {
  return decodeStoryData(text).ok;
}

function twee1MetadataWarning(passages: readonly ReadonlyPassage[]): Diagnostic[] {
  const count = passages.filter((p) => metadataForOutput(p.metadata) !== undefined).length;
  if (count === 0) return [];
  return [
    {
      level: 'warning',
      message: `Twee 1 has no passage metadata, so the metadata (such as "position") of ${count} ${count === 1 ? 'passage is' : 'passages are'} left out.`,
    },
  ];
}

/** A passage as it is written to Twee, and the warnings about what will not read back the same. */
interface WrittenPassage {
  readonly twee: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The Twee written for a passage, and the passages the Twee reader reads from it (none on a reader error). */
interface ReadBack {
  readonly twee: string;
  readonly passages: readonly Passage[];
}

function readBack(p: ReadonlyPassage, outMode: OutputMode): ReadBack {
  const twee = passageToTwee(p, outMode);
  const { passages, diagnostics } = parseTwee(twee);
  return { twee, passages: diagnostics.some((d) => d.level === 'error') ? [] : passages };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** The metadata as written: its entries with a value, in order (see `metadataForOutput`). */
function metadataEntries(p: ReadonlyPassage): [string, string][] {
  return Object.entries(metadataForOutput(p.metadata) ?? {});
}

function sameEntries(a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]): boolean {
  return sameStrings(
    a.map((entry) => JSON.stringify(entry)),
    b.map((entry) => JSON.stringify(entry)),
  );
}

/** Characters Twee 3 escapes in names and tags, and Twee 1 cannot write there at all. */
const TWEE1_UNWRITABLE = /[[\]{}\\]/;

/** Why a name may not read back as written; empty when nothing is known to be wrong with it. */
function nameProblems(name: string, outMode: OutputMode): string[] {
  const trimmed = trimTweeSpace(name);
  return [
    ...(trimmed === '' ? ['its name is empty'] : []),
    ...(trimmed !== '' && trimmed !== name ? ['its name has leading or trailing whitespace, which Twee drops'] : []),
    ...(/[\r\n]/.test(name) ? ['its name has a line break, which ends a Twee passage header'] : []),
    ...(outMode === 'twee1' && TWEE1_UNWRITABLE.test(name)
      ? ['its name has "[", "]", "{", "}" or "\\", which Twee 1 cannot escape']
      : []),
  ];
}

/** Why tags may not read back as written; empty when nothing is known to be wrong with them. */
function tagProblems(tags: readonly string[], outMode: OutputMode): string[] {
  // A tag reads back as itself only when it is one field: not empty, with no white space.
  const isOneField = (tag: string): boolean => sameStrings(splitTweeFields(tag), [tag]);
  return tags.flatMap((tag) => [
    ...(isOneField(tag)
      ? []
      : [`its tag ${JSON.stringify(tag)} is empty or has whitespace, which splits tags in Twee`]),
    ...(outMode === 'twee1' && TWEE1_UNWRITABLE.test(tag)
      ? [`its tag ${JSON.stringify(tag)} has "[", "]", "{", "}" or "\\", which Twee 1 cannot escape`]
      : []),
  ]);
}

/** `known` when it says anything, else `fallback`. */
function orElse(known: readonly string[], fallback: string): readonly string[] {
  return known.length > 0 ? known : [fallback];
}

/**
 * The differences between a passage and what reading its Twee gives, as phrases for a warning. Whether there
 * are any is decided by comparing with what the reader gave; the phrases say why, where that is known.
 */
function differences(p: ReadonlyPassage, { passages }: ReadBack, outMode: OutputMode): string[] {
  const headerLines = textHeaderLines(p.text);
  const problems = headerLines.length > 0 ? [describeHeaderLines(headerLines)] : [];
  const [back] = passages;
  if (back === undefined) {
    return [
      ...problems,
      ...orElse([...nameProblems(p.name, outMode), ...tagProblems(p.tags, outMode)], 'its header cannot be read back'),
    ];
  }
  // A name that reads back differently may have taken part of the header or text with it: nothing else is
  // worth comparing.
  if (back.name !== p.name) {
    return [
      ...problems,
      ...orElse(nameProblems(p.name, outMode), `its name reads back as ${JSON.stringify(back.name)}`),
    ];
  }
  if (!sameStrings(back.tags, p.tags)) {
    pushAll(problems, orElse(tagProblems(p.tags, outMode), `its tags read back as ${JSON.stringify(back.tags)}`));
  }
  if (outMode === 'twee3' && !sameEntries(metadataEntries(back), metadataEntries(p))) {
    problems.push(`its metadata reads back as ${JSON.stringify(ownRecord(metadataEntries(back)))}`);
  }
  // With the header read back as written and no text line read as a header, the Twee holds one passage, and
  // only a carriage return (read as a line break) can change its text.
  if (headerLines.length === 0 && back.text !== trimTweeSpace(p.text)) {
    problems.push('its text reads back differently (Twee reads a carriage return as a line break)');
  }
  return problems;
}

/** `p` with each text line that reads as a passage header indented by one space. */
function withHeaderLinesIndented(p: ReadonlyPassage): ReadonlyPassage {
  const parts = p.text.split(/(\r\n|\r|\n)/);
  return { ...p, text: parts.map((part, i) => (i % 2 === 0 && isHeaderLine(part) ? ` ${part}` : part)).join('') };
}

/**
 * Write `p` as Twee, check that it reads back the same, and say what does not. Twee has no way to escape
 * passage text, so a text line that reads as a passage header (it starts with `::`, after any byte order
 * marks) cannot be written. In stylesheet and script passages such a line is indented by one space, which
 * keeps the CSS or JavaScript working (only a template literal or a string continued across lines would see
 * the space), and the warning says so; other passages' text is written as it is.
 */
function tweeRoundTrip(p: ReadonlyPassage, outMode: OutputMode): WrittenPassage {
  const label = `Passage ${JSON.stringify(p.name)}`;
  const headerLines = textHeaderLines(p.text);
  const indent = headerLines.length > 0 && p.tags.some((tag) => tag === 'stylesheet' || tag === 'script');
  const written = indent ? withHeaderLinesIndented(p) : p;
  const back = readBack(written, outMode);
  // Indenting leaves no header lines, so `differences` below reports only what else changes.
  const notes: Diagnostic[] = indent
    ? [
        {
          level: 'warning',
          message: `${label}: ${describeHeaderLines(headerLines)}; ${headerLines.length === 1 ? 'it was' : 'they were'} written indented by one space.`,
        },
      ]
    : [];
  const problems = differences(written, back, outMode).map((problem): Diagnostic => ({
    level: 'warning',
    message: `${label} cannot be written as Twee that reads back the same: ${problem}.`,
  }));
  return { twee: back.twee, diagnostics: [...notes, ...problems] };
}

/** The numbers (from 1) of the lines of `text` that read as passage headers. */
function textHeaderLines(text: string): number[] {
  return sourceLines(text).flatMap((line, i) => (isHeaderLine(line) ? [i + 1] : []));
}

function describeHeaderLines(lines: readonly number[]): string {
  const one = lines.length === 1;
  return `${one ? 'line' : 'lines'} ${lines.join(', ')} of its text start${one ? 's' : ''} with "::", which Twee reads as a passage header`;
}
