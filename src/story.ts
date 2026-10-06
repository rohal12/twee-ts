/**
 * Story model + StoryData JSON marshal/unmarshal.
 * Ported from story.go + storydata.go.
 *
 * The story metadata (`name`, `ifid`, `legacyIFID`, `twine1`, `twine2`) is decided by the special passages that
 * are in the story: StoryTitle, StoryData and StorySettings. Each one decides its part entirely, from its own
 * text: a later passage of the same name replaces the earlier passage and everything it decided, and removing
 * it puts its part back to the defaults. So the metadata always equals `deriveStoryMetadata(story.passages)`,
 * whatever order passages arrive in and whatever was wrong with an earlier one.
 */
import type {
  Story,
  ReadonlyStory,
  Passage,
  ReadonlyPassage,
  Diagnostic,
  WordCountMethod,
  IFID,
  SourceLocation,
  Twine2Metadata,
} from './types.js';
import { normalizeIFID, validateIFID } from './ifid.js';
import { isStoryPassage, countWords, derivePassage, generatedNameOf, withGeneratedName } from './passage.js';
import type { GeneratedName } from './passage.js';
import { trimTweeSpace } from './twee-syntax.js';
import type { DecodeIssue, DecodeIssueKind, TextDecodeResult } from './json-decode.js';
import {
  field,
  jsonArrayOf,
  jsonNumber,
  jsonRecordOf,
  jsonString,
  nullAsZero,
  ownRecord,
  readObjectText,
} from './json-decode.js';

// --- Passage name index ---

/**
 * A story's passage positions by name, for O(1) lookups. Only the functions of this module change
 * `story.passages` in place, and they keep the index up to date. Assigning `story.passages` a new array (as
 * the compiler does after applying tag aliases) is noticed by its identity and length, and the index rebuilt.
 */
interface NameIndex {
  /** The array the index describes. */
  readonly passages: readonly Passage[];
  /** Its length when the index was last updated. */
  length: number;
  /** Position by name; with duplicate names in the array, the last position. */
  readonly positions: Map<string, number>;
}

const passageIndex = new WeakMap<Story, NameIndex>();

function buildIndex(story: Story): NameIndex {
  const positions = new Map(story.passages.map((p, i) => [p.name, i]));
  const index: NameIndex = { passages: story.passages, length: story.passages.length, positions };
  passageIndex.set(story, index);
  return index;
}

/** The index, rebuilt if `story.passages` was reassigned or changed length. */
function currentIndex(story: Story): NameIndex {
  const index = passageIndex.get(story);
  return index?.passages === story.passages && index.length === story.passages.length ? index : buildIndex(story);
}

/** The position of the passage named `name`, or -1. A hit is checked against the passage there. */
function position(story: Story, name: string): number {
  const i = currentIndex(story).positions.get(name);
  if (i === undefined) return -1;
  if (story.passages[i]?.name === name) return i;
  return buildIndex(story).positions.get(name) ?? -1;
}

/** Add a passage whose name no passage has yet at the end. */
function push(story: Story, p: Passage): void {
  const index = currentIndex(story);
  index.positions.set(p.name, story.passages.length);
  story.passages.push(p);
  index.length = story.passages.length;
}

/** Put a passage at position `i`, in place of the passage there. */
function replaceAt(story: Story, i: number, p: Passage): void {
  const renamed = story.passages[i]?.name !== p.name;
  story.passages[i] = p;
  if (renamed) buildIndex(story);
}

/** Take the passage at position `i` out. */
function removeAt(story: Story, i: number): void {
  story.passages.splice(i, 1);
  buildIndex(story);
}

// --- Generated passage names ---

/** Names of compiler special passages, which storyAdd() reads into the story model. */
const SPECIAL_PASSAGE_NAMES: ReadonlySet<string> = new Set([
  'StoryData',
  'StoryIncludes',
  'StorySettings',
  'StoryTitle',
]);

/** The first of `base`, `base 2`, `base 3`, … that `isFree` accepts. */
export function freeName(base: string, isFree: (name: string) => boolean): string {
  if (isFree(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (isFree(candidate)) return candidate;
  }
}

/** Whether a generated name may take `name`: no passage has it and it is no special name. */
function isFreeForGenerated(story: Story, name: string): boolean {
  return !SPECIAL_PASSAGE_NAMES.has(name) && position(story, name) === -1;
}

function reportRename(origin: GeneratedName, from: string, to: string, diagnostics: Diagnostic[]): void {
  switch (origin.kind) {
    case 'code':
      return;
    case 'media': {
      const reason = SPECIAL_PASSAGE_NAMES.has(from)
        ? `"${from}" is a compiler special passage name`
        : `another passage has the name "${from}"`;
      diagnostics.push({
        level: 'warning',
        message: `Passage "${from}" from "${origin.file}" renamed to "${to}"; ${reason}.`,
      });
      return;
    }
    default: {
      const _exhaustive: never = origin;
      throw new Error(`unhandled generated name: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Add a passage with a generated name, under the first free name if its own is taken. */
function addGenerated(story: Story, p: Passage, origin: GeneratedName, diagnostics: Diagnostic[]): void {
  if (isFreeForGenerated(story, p.name)) {
    push(story, p);
    return;
  }
  const name = freeName(origin.base, (n) => isFreeForGenerated(story, n));
  reportRename(origin, p.name, name, diagnostics);
  push(story, withGeneratedName(derivePassage(p, { name }), origin));
}

/**
 * If a passage with a generated name has `name`, give it the first free name, in its place in the
 * passage list, so that a passage from the sources can take the name.
 */
function moveGeneratedAside(story: Story, name: string, diagnostics: Diagnostic[]): void {
  const i = position(story, name);
  const existing = i === -1 ? undefined : story.passages[i];
  const origin = existing === undefined ? undefined : generatedNameOf(existing);
  if (existing === undefined || origin === undefined) return;
  const free = freeName(origin.base, (n) => isFreeForGenerated(story, n));
  reportRename(origin, name, free, diagnostics);
  replaceAt(story, i, withGeneratedName(derivePassage(existing, { name: free }), origin));
}

// --- Story ---

function defaultTwine2Metadata(): Twine2Metadata {
  return {
    format: '',
    formatVersion: '',
    options: new Map(),
    start: '',
    tags: '',
    tagColors: new Map(),
    zoom: 1,
  };
}

/** No IFID: the empty string. Only the empty string is ever branded without validation. */
const NO_IFID = normalizeIFID('');

export function createStory(): Story {
  const story: Story = {
    name: '',
    ifid: NO_IFID,
    passages: [],
    legacyIFID: NO_IFID,
    twine1: { settings: new Map() },
    twine2: defaultTwine2Metadata(),
  };
  buildIndex(story);
  return story;
}

export function storyHas(story: Story, name: string): boolean {
  return position(story, name) !== -1;
}

export function storyGet(story: Story, name: string): Passage | undefined {
  const i = position(story, name);
  return i === -1 ? undefined : story.passages[i];
}

// --- Diagnostics with source locations ---

/** Where a passage came from, for a diagnostic: `{ file, line }`, or nothing for a passage made in memory. */
function at(source: SourceLocation | undefined): { file?: string; line?: number } {
  return source === undefined ? {} : { file: source.file, line: source.line };
}

/**
 * The warning for `p` replacing `existing`. It is located at `p`, and says where the replaced passage was, so
 * that both copies can be found.
 */
function duplicateWarning(existing: Passage | undefined, p: Passage): Diagnostic {
  const source = existing?.source;
  const where = source === undefined ? '' : ` It replaces the one from ${source.file} (line ${source.line}).`;
  return {
    level: 'warning',
    message: `Replacing existing passage "${p.name}" with duplicate.${where}`,
    ...at(p.source),
  };
}

// --- StoryData JSON ---

export function marshalStoryData(story: ReadonlyStory): string {
  const options = [...story.twine2.options].flatMap(([opt, on]) => (on ? [opt] : []));
  // Keys in the order Tweego writes them; each only when set. `tag-colors` keys are own properties.
  const data = {
    ...(story.ifid ? { ifid: story.ifid } : {}),
    ...(story.twine2.format ? { format: story.twine2.format } : {}),
    ...(story.twine2.formatVersion ? { 'format-version': story.twine2.formatVersion } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(story.twine2.start ? { start: story.twine2.start } : {}),
    ...(story.twine2.tags ? { tags: story.twine2.tags } : {}),
    ...(story.twine2.tagColors.size > 0 ? { 'tag-colors': ownRecord(story.twine2.tagColors) } : {}),
    ...(story.twine2.zoom !== 1 ? { zoom: story.twine2.zoom } : {}),
  };
  return JSON.stringify(data, null, '\t');
}

/** The StoryData read; its issues are about fields left out or keys read as another (see `storyDataIssueLevel`). */
type StoryDataDecodeResult = TextDecodeResult<{ readonly ifid: IFID; readonly twine2: Twine2Metadata }>;

/**
 * Decode the text of a StoryData passage, as Tweego decodes it into its `storyDataJSON` struct with Go's
 * `encoding/json`:
 *
 * - Keys match the field names regardless of letter case (`IFID` is `ifid`); a repeated key takes the last
 *   value. `null` reads as the field's zero value. Every field the text leaves out has its default.
 * - A field of the wrong type is left out (`zoom: "2"`); Tweego stops with an error there.
 * - An unknown key is left out (as in Tweego); `tags` (the Twine 2 story tags) is read, which Tweego does not.
 * - A `zoom` of 0 is the default zoom, 1.
 *
 * Every field left out and every key read as another one gives an issue. Text that is not a JSON object gives
 * `ok: false`.
 */
export function decodeStoryData(text: string): StoryDataDecodeResult {
  const twine2 = defaultTwine2Metadata();
  let ifid = NO_IFID;
  const str = nullAsZero(jsonString, '');
  const read = readObjectText(text, {
    keys: 'go',
    fields: {
      ifid: field(str, (v) => {
        ifid = normalizeIFID(v);
      }),
      format: field(str, (v) => {
        twine2.format = v;
      }),
      'format-version': field(str, (v) => {
        twine2.formatVersion = v;
      }),
      options: field(nullAsZero(jsonArrayOf(str), []), (v) => {
        twine2.options = new Map(v.map((o) => [o, true]));
      }),
      start: field(str, (v) => {
        twine2.start = v;
      }),
      tags: field(str, (v) => {
        twine2.tags = v;
      }),
      'tag-colors': field(nullAsZero(jsonRecordOf(str), new Map<string, string>()), (v) => {
        twine2.tagColors = new Map(v);
      }),
      zoom: field(nullAsZero(jsonNumber, 0), (v) => {
        twine2.zoom = v === 0 ? 1 : v;
      }),
    },
  });
  return read.ok ? { ok: true, ifid, twine2, issues: read.issues } : read;
}

/**
 * How a StoryData issue is reported. A wrong-typed value is an error, since Tweego stops there and the story
 * would otherwise be built with another format, start or IFID than the author wrote. The rest are warnings:
 * the value is used (a case variant or repeated key) or was never part of StoryData (an unknown key), but the
 * StoryData passage is rewritten without it.
 */
function storyDataIssueLevel(kind: DecodeIssueKind): Diagnostic['level'] {
  switch (kind) {
    case 'type':
      return 'error';
    case 'unknown-key':
    case 'case-variant-key':
    case 'duplicate-key':
      return 'warning';
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled decode issue kind: ${String(_exhaustive)}`);
    }
  }
}

function storyDataIssueMessage(issue: DecodeIssue): string {
  switch (issue.kind) {
    case 'type':
      return `"StoryData" ${issue.message}; the field is left out.`;
    case 'unknown-key':
      return `"StoryData" ${issue.message}; it is left out.`;
    case 'case-variant-key':
    case 'duplicate-key':
      return `"StoryData" ${issue.message}.`;
    default: {
      const _exhaustive: never = issue.kind;
      throw new Error(`unhandled decode issue kind: ${String(_exhaustive)}`);
    }
  }
}

// --- StorySettings (legacy) ---

/** Lower case as Go's `bytes.ToLower`: each code point mapped on its own (U+0130 İ to i, Σ always to σ). */
function goToLower(s: string): string {
  let out = '';
  for (const ch of s) out += ch === 'İ' ? 'i' : ch.toLowerCase();
  return out;
}

interface StorySettingsData {
  readonly settings: ReadonlyMap<string, string>;
  /** The IFID of a valid `ifid` entry, or empty. */
  readonly legacyIFID: IFID;
  /** Lines with no `:`, which are skipped. */
  readonly malformed: readonly string[];
  /** The obsolete keys found (`ifid`, `zoom`), quoted, in order. */
  readonly obsolete: readonly string[];
}

/**
 * Decode the text of a StorySettings passage, as Tweego does: each line that holds a `:` is a `key:value`
 * pair, both trimmed and lower-cased; a repeated key takes the last value. `ifid` and `zoom` are obsolete:
 * a valid `ifid` is kept as the legacy IFID, and neither is a setting.
 */
function decodeStorySettings(text: string): StorySettingsData {
  const settings = new Map<string, string>();
  const malformed: string[] = [];
  const obsolete: string[] = [];
  let legacyIFID = NO_IFID;
  for (const rawLine of text.split('\n')) {
    const line = trimTweeSpace(rawLine);
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      malformed.push(line);
      continue;
    }
    const key = goToLower(trimTweeSpace(line.slice(0, colon)));
    const val = goToLower(trimTweeSpace(line.slice(colon + 1)));
    switch (key) {
      case 'ifid':
        if (validateIFID(val) === null) legacyIFID = normalizeIFID(val);
        obsolete.push('"ifid"');
        break;
      case 'zoom':
        obsolete.push('"zoom"');
        break;
      default:
        // Any other key is a setting.
        settings.set(key, val);
        break;
    }
  }
  return { settings, legacyIFID, malformed, obsolete };
}

function storySettingsDiagnostics(data: StorySettingsData, source: SourceLocation | undefined): Diagnostic[] {
  const diagnostics: Diagnostic[] = data.malformed.map((line) => ({
    level: 'warning',
    message: `Malformed "StorySettings" entry; skipping "${line}".`,
    ...at(source),
  }));
  if (data.obsolete.length > 0) {
    const entries = data.obsolete.length === 1 ? 'entry' : 'entries';
    const pronoun = data.obsolete.length === 1 ? 'it' : 'them';
    diagnostics.push({
      level: 'warning',
      message:
        `Detected obsolete "StorySettings" ${entries}: ${data.obsolete.join(', ')}. ` +
        `Please remove ${pronoun} from the "StorySettings" special passage.`,
      ...at(source),
    });
  }
  return diagnostics;
}

/**
 * Set the StorySettings part of the story's metadata (`twine1.settings` and `legacyIFID`) from the text of a
 * StorySettings passage, replacing what an earlier one set.
 */
export function unmarshalStorySettings(story: Story, text: string, diagnostics: Diagnostic[]): void {
  const data = decodeStorySettings(text);
  story.twine1 = { settings: new Map(data.settings) };
  story.legacyIFID = data.legacyIFID;
  diagnostics.push(...storySettingsDiagnostics(data, undefined));
}

// --- Story metadata from special passages ---

/** The parts of a story that its special passages decide. */
export type StoryMetadata = Pick<Story, 'name' | 'ifid' | 'legacyIFID' | 'twine1' | 'twine2'>;

/**
 * Set the part of the story metadata that a special passage decides from that passage alone, and return the
 * passage as the story stores it (a StoryTitle trimmed; a StoryData that decodes rewritten from what was
 * read, as Tweego does, so that every field it left out was reported). Any other passage is returned as is.
 */
function readSpecialPassage(story: Story, p: Passage, diagnostics: Diagnostic[]): Passage {
  switch (p.name) {
    case 'StoryIncludes':
      diagnostics.push({
        level: 'warning',
        message:
          'Ignoring "StoryIncludes" compiler special passage; twee-ts allows you to specify project files and/or directories to recursively search.',
        ...at(p.source),
      });
      return p;

    case 'StoryData': {
      const decoded = decodeStoryData(p.text);
      if (!decoded.ok) {
        // The passage still replaces any earlier StoryData, so the story has none of its metadata.
        story.ifid = NO_IFID;
        story.twine2 = defaultTwine2Metadata();
        diagnostics.push({
          level: 'error',
          message: `Cannot unmarshal "StoryData" compiler special passage; ${decoded.reason}. Its metadata (IFID, format, start, …) is not used.`,
          ...at(p.source),
        });
        return p;
      }
      story.ifid = decoded.ifid;
      story.twine2 = decoded.twine2;
      for (const issue of decoded.issues) {
        diagnostics.push({
          level: storyDataIssueLevel(issue.kind),
          message: storyDataIssueMessage(issue),
          ...at(p.source),
        });
      }
      const ifidError = decoded.ifid.length > 0 ? validateIFID(decoded.ifid) : null;
      if (ifidError !== null) {
        diagnostics.push({ level: 'error', message: `Cannot validate IFID; ${ifidError}.`, ...at(p.source) });
      }
      return derivePassage(p, { text: marshalStoryData(story) });
    }

    case 'StorySettings': {
      const data = decodeStorySettings(p.text);
      story.twine1 = { settings: new Map(data.settings) };
      story.legacyIFID = data.legacyIFID;
      diagnostics.push(...storySettingsDiagnostics(data, p.source));
      return p;
    }

    case 'StoryTitle': {
      const name = trimTweeSpace(p.text);
      story.name = name;
      return derivePassage(p, { text: name });
    }

    default:
      // Any other name is an ordinary passage.
      return p;
  }
}

/** Put the part of the story metadata that the special passage `name` decides back to its defaults. */
function clearSpecialPassage(story: Story, name: string): void {
  switch (name) {
    case 'StoryData':
      story.ifid = NO_IFID;
      story.twine2 = defaultTwine2Metadata();
      return;
    case 'StorySettings':
      story.twine1 = { settings: new Map() };
      story.legacyIFID = NO_IFID;
      return;
    case 'StoryTitle':
      story.name = '';
      return;
    default:
      // Other passages decide nothing.
      return;
  }
}

/**
 * The story metadata that a list of passages decides: what its StoryTitle, StoryData and StorySettings
 * passages say, or the defaults for each one that is missing. When a name is repeated, the last passage
 * decides, as it would replace the others. Pure; diagnostics are not reported.
 */
export function deriveStoryMetadata(passages: readonly ReadonlyPassage[]): StoryMetadata {
  const story = createStory();
  for (const p of passages) {
    if (SPECIAL_PASSAGE_NAMES.has(p.name)) {
      readSpecialPassage(story, { name: p.name, tags: [...p.tags], text: p.text }, []);
    }
  }
  const { name, ifid, legacyIFID, twine1, twine2 } = story;
  return { name, ifid, legacyIFID, twine1, twine2 };
}

// --- Adding passages ---

/**
 * Add `p` at the end (or the front), or in place of the passage with its name, with a warning that says
 * where both came from.
 */
function storyPlace(story: Story, p: Passage, diagnostics: Diagnostic[], where: 'end' | 'front'): void {
  const i = position(story, p.name);
  if (i !== -1) {
    diagnostics.push(duplicateWarning(story.passages[i], p));
    replaceAt(story, i, p);
  } else if (where === 'end') {
    push(story, p);
  } else {
    story.passages.unshift(p);
    // Every position moves up by one.
    buildIndex(story);
  }
}

/**
 * Add a passage at the front, or in place of the passage with its name, with a warning. A special passage
 * added this way is not read into the metadata: the caller adds one that holds the story's metadata (a
 * StoryTitle with the story name, or a StoryData written from the story).
 */
export function storyPrepend(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  moveGeneratedAside(story, p.name, diagnostics);
  storyPlace(story, p, diagnostics, 'front');
}

/**
 * Add a passage to the story. A special passage (StoryTitle, StoryData, StorySettings, StoryIncludes) also
 * sets the part of the metadata it decides, replacing what an earlier one of its name set (see
 * `readSpecialPassage`). The input passage is not changed; the story may store a rewritten copy.
 *
 * A passage replaces an earlier one with the same name, except where either name was generated
 * (see `withGeneratedName()`): a generated name never replaces a passage and is never replaced.
 * A passage with a generated name takes the first free name of `base`, `base 2`, … when its own
 * is taken or is a compiler special name. A passage with a name from the sources that a generated
 * name holds takes it over, and the generated one moves to the first free name in its place.
 */
export function storyAdd(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  const origin = generatedNameOf(p);
  if (origin !== undefined) {
    addGenerated(story, p, origin, diagnostics);
    return;
  }
  moveGeneratedAside(story, p.name, diagnostics);
  storyPlace(story, readSpecialPassage(story, p, diagnostics), diagnostics, 'end');
}

/** Take the passage named `name` out of the story, with the metadata it decided. Returns it, if there was one. */
function storyRemove(story: Story, name: string): Passage | undefined {
  const i = position(story, name);
  const p = story.passages[i];
  if (p === undefined) return undefined;
  removeAt(story, i);
  clearSpecialPassage(story, name);
  return p;
}

/**
 * Rename the passage named `from` to `to`, keeping its place. A passage already named `to` is replaced, with
 * a warning. Metadata follows the names: renaming a StoryData passage away removes its metadata, and
 * renaming a passage to StoryData reads it as StoryData. Returns false when no passage is named `from`.
 */
function storyRename(story: Story, from: string, to: string, diagnostics: Diagnostic[]): boolean {
  const p = storyGet(story, from);
  if (p === undefined) return false;
  if (from === to) return true;
  const renamed = derivePassage(p, { name: to });
  const existing = storyGet(story, to);
  if (existing !== undefined) {
    diagnostics.push(duplicateWarning(existing, renamed));
    storyRemove(story, to);
  }
  clearSpecialPassage(story, from);
  // Its position after any removal above.
  replaceAt(story, position(story, from), readSpecialPassage(story, renamed, diagnostics));
  return true;
}

/** Get story passage count and word count stats. */
export function getStoryStats(
  story: Story,
  wordCountMethod: WordCountMethod = 'tweego',
): { passages: number; storyPassages: number; words: number } {
  let storyPassages = 0;
  let words = 0;
  for (const p of story.passages) {
    if (isStoryPassage(p)) {
      storyPassages++;
      words += countWords(p, wordCountMethod);
    }
  }
  return { passages: story.passages.length, storyPassages, words };
}

// --- StoryBuilder ---

/** A copy of a passage that shares nothing with it; metadata keys stay own properties. */
function copyPassage(p: ReadonlyPassage): Passage {
  return {
    name: p.name,
    tags: [...p.tags],
    text: p.text,
    ...(p.metadata === undefined ? {} : { metadata: ownRecord(Object.entries(p.metadata)) }),
    ...(p.source === undefined ? {} : { source: { file: p.source.file, line: p.source.line } }),
  };
}

function frozenPassage(p: ReadonlyPassage): ReadonlyPassage {
  const copy = copyPassage(p);
  Object.freeze(copy.tags);
  if (copy.metadata !== undefined) Object.freeze(copy.metadata);
  if (copy.source !== undefined) Object.freeze(copy.source);
  return Object.freeze(copy);
}

/** A frozen copy of the story: later changes to it do not reach the copy, and the copy cannot be changed. */
export function snapshot(story: Story): ReadonlyStory {
  return Object.freeze({
    name: story.name,
    ifid: story.ifid,
    legacyIFID: story.legacyIFID,
    passages: Object.freeze(story.passages.map(frozenPassage)),
    twine1: Object.freeze({ settings: new Map(story.twine1.settings) }),
    twine2: Object.freeze({
      ...story.twine2,
      options: new Map(story.twine2.options),
      tagColors: new Map(story.twine2.tagColors),
    }),
  });
}

/**
 * Builds a story from passages, as the compiler does: duplicates replace earlier passages (with a warning),
 * and the special passages StoryTitle, StoryData and StorySettings decide the story metadata.
 *
 * The story is changed only through the builder's methods, so its passage list, its name lookups and its
 * metadata always agree. Passages are copied in and out: changing a passage object after `add()`, or one that
 * `get()`, `passages` or `build()` returned, does not change the builder.
 */
export class StoryBuilder {
  readonly #story: Story = createStory();

  /** Add a passage, handling special passages (StoryData, StoryTitle, etc.) and duplicates. */
  add(passage: Passage, diagnostics: Diagnostic[]): void {
    storyAdd(this.#story, copyPassage(passage), diagnostics);
  }

  /** Whether a passage has this name. */
  has(name: string): boolean {
    return storyHas(this.#story, name);
  }

  /** The passage with this name (a frozen copy), or undefined. */
  get(name: string): ReadonlyPassage | undefined {
    const p = storyGet(this.#story, name);
    return p === undefined ? undefined : frozenPassage(p);
  }

  /**
   * Remove the passage with this name, and with it the metadata it decided (removing StoryData clears the
   * IFID, format and start). Returns false when no passage has the name.
   */
  remove(name: string): boolean {
    return storyRemove(this.#story, name) !== undefined;
  }

  /**
   * Rename a passage, keeping its place in the story. A passage that already has the new name is replaced,
   * with a warning, as a duplicate would be. Returns false when no passage has the old name.
   */
  rename(from: string, to: string, diagnostics: Diagnostic[]): boolean {
    return storyRename(this.#story, from, to, diagnostics);
  }

  /** The passages, in order (frozen copies). */
  get passages(): readonly ReadonlyPassage[] {
    return Object.freeze(this.#story.passages.map(frozenPassage));
  }

  /** The story as it is now, as a frozen copy that later changes to the builder do not reach. */
  build(): ReadonlyStory {
    return snapshot(this.#story);
  }
}
