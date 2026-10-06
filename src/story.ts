/**
 * Story model + StoryData JSON marshal/unmarshal.
 * Ported from story.go + storydata.go.
 */
import type { Story, ReadonlyStory, Passage, Diagnostic, WordCountMethod, IFID } from './types.js';
import { normalizeIFID, validateIFID } from './ifid.js';
import { isStoryPassage, countWords } from './passage.js';

// --- Passage name index ---

/**
 * A story's passage positions by name, for O(1) lookups. `story.passages` is a plain mutable
 * array that code outside this module may change (StoryBuilder documents it), so the index
 * records what it was built from and is rebuilt when that no longer matches.
 */
interface NameIndex {
  /** The array the index describes; assigning `story.passages` gives a different one. */
  readonly passages: readonly Passage[];
  /** The name at each position when the index was last updated. */
  readonly names: string[];
  /** Position by name; with duplicate names in the array, the last position. */
  readonly positions: Map<string, number>;
}

const passageIndex = new WeakMap<Story, NameIndex>();

function buildIndex(story: Story): NameIndex {
  const names = story.passages.map((p) => p.name);
  const index: NameIndex = { passages: story.passages, names, positions: new Map(names.map((name, i) => [name, i])) };
  passageIndex.set(story, index);
  return index;
}

/**
 * The index, rebuilt if `story.passages` was reassigned or changed length. O(1); `position()`
 * also checks every hit. A change that keeps the length, such as replacing an element, can still
 * hide a passage from a lookup, so `storyVerifyIndex()` checks every position.
 */
function currentIndex(story: Story): NameIndex {
  const index = passageIndex.get(story);
  return index?.passages === story.passages && index.names.length === story.passages.length ? index : buildIndex(story);
}

/**
 * Rebuild the index unless it matches `story.passages` at every position. O(n): for entry points
 * that run after code outside the compiler may have changed the passages, such as StoryBuilder.
 */
function storyVerifyIndex(story: Story): void {
  const index = currentIndex(story);
  if (!story.passages.every((p, i) => p.name === index.names[i])) buildIndex(story);
}

/** The position of the passage named `name`, or -1. */
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
  index.names.push(p.name);
  story.passages.push(p);
}

/** Put a passage at position `i`, in place of the passage there. */
function replaceAt(story: Story, i: number, p: Passage): void {
  const renamed = story.passages[i]?.name !== p.name;
  story.passages[i] = p;
  // Only moving a generated name aside renames a position; that is rare, so rebuild then.
  if (renamed) buildIndex(story);
}

// --- Generated passage names ---

/** Names of compiler special passages, which storyAdd() reads into the story model. */
const SPECIAL_PASSAGE_NAMES: ReadonlySet<string> = new Set([
  'StoryData',
  'StoryIncludes',
  'StorySettings',
  'StoryTitle',
]);

/**
 * Where a passage name that the compiler made up came from. Generated names yield to every other
 * name in the story: see `storyAdd()`.
 * - `code`: a stylesheet or script (a `.css`, `.js` or font file, or an imported Twine 2 story's
 *   stylesheet or script). Output finds these by tag, so a new name is not reported.
 * - `media`: an image, audio, video or text track file. Stories refer to these by passage name,
 *   so a new name is reported.
 */
export type GeneratedName =
  | { readonly kind: 'code'; readonly base: string }
  | { readonly kind: 'media'; readonly base: string; readonly file: string };

/** Passages whose names were generated, kept by identity so that cached passages keep the mark. */
const generatedNames = new WeakMap<Passage, GeneratedName>();

/**
 * Mark a passage's name as generated (from a file name, or for imported story code) and return
 * the passage. `origin.base` is the name that free names are numbered from: `base`, `base 2`, ….
 */
export function withGeneratedName(p: Passage, origin: GeneratedName): Passage {
  generatedNames.set(p, origin);
  return p;
}

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
  push(story, withGeneratedName({ ...p, name }, origin));
}

/**
 * If a passage with a generated name has `name`, give it the first free name, in its place in the
 * passage list, so that a passage from the sources can take the name.
 */
function moveGeneratedAside(story: Story, name: string, diagnostics: Diagnostic[]): void {
  const i = position(story, name);
  const existing = i === -1 ? undefined : story.passages[i];
  const origin = existing === undefined ? undefined : generatedNames.get(existing);
  if (existing === undefined || origin === undefined) return;
  const free = freeName(origin.base, (n) => isFreeForGenerated(story, n));
  reportRename(origin, name, free, diagnostics);
  replaceAt(story, i, withGeneratedName({ ...existing, name: free }, origin));
}

// --- Story ---

function defaultTwine2Metadata(): Story['twine2'] {
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

export function createStory(): Story {
  const story: Story = {
    name: '',
    ifid: '' as IFID,
    passages: [],
    legacyIFID: '' as IFID,
    twine1: { settings: new Map() },
    twine2: defaultTwine2Metadata(),
  };
  buildIndex(story);
  return story;
}

export function storyHas(story: Story, name: string): boolean {
  return position(story, name) !== -1;
}

export function storyIndex(story: Story, name: string): number {
  return position(story, name);
}

export function storyGet(story: Story, name: string): Passage | undefined {
  const i = position(story, name);
  return i === -1 ? undefined : story.passages[i];
}

function storyAppend(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  const i = position(story, p.name);
  if (i === -1) {
    push(story, p);
  } else {
    diagnostics.push({
      level: 'warning',
      message: `Replacing existing passage "${p.name}" with duplicate.`,
    });
    replaceAt(story, i, p);
  }
}

export function storyPrepend(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  moveGeneratedAside(story, p.name, diagnostics);
  const i = position(story, p.name);
  if (i === -1) {
    story.passages.unshift(p);
    // Every position moves up by one.
    buildIndex(story);
  } else {
    diagnostics.push({
      level: 'warning',
      message: `Replacing existing passage "${p.name}" with duplicate.`,
    });
    replaceAt(story, i, p);
  }
}

// --- StoryData JSON ---

interface StoryDataJSON {
  ifid?: string;
  format?: string;
  'format-version'?: string;
  options?: string[];
  start?: string;
  tags?: string;
  'tag-colors'?: Record<string, string>;
  zoom?: number;
}

export function marshalStoryData(story: ReadonlyStory): string {
  const data: StoryDataJSON = {};
  if (story.ifid) data.ifid = story.ifid;
  if (story.twine2.format) data.format = story.twine2.format;
  if (story.twine2.formatVersion) data['format-version'] = story.twine2.formatVersion;

  const options: string[] = [];
  for (const [opt, val] of story.twine2.options) {
    if (val) options.push(opt);
  }
  if (options.length > 0) data.options = options;

  if (story.twine2.start) data.start = story.twine2.start;
  if (story.twine2.tags) data.tags = story.twine2.tags;

  if (story.twine2.tagColors.size > 0) {
    data['tag-colors'] = Object.fromEntries(story.twine2.tagColors);
  }
  if (story.twine2.zoom !== 1) data.zoom = story.twine2.zoom;

  return JSON.stringify(data, null, '\t');
}

/** StoryData as JSON.parse() gives it: any field may hold any value. */
type UnvalidatedStoryData = { readonly [K in keyof StoryDataJSON]?: unknown };

export function unmarshalStoryData(story: Story, json: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (e) {
    return `Cannot unmarshal "StoryData"; ${e instanceof Error ? e.message : String(e)}`;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Cannot unmarshal "StoryData"; expected a JSON object';
  }
  const data: UnvalidatedStoryData = raw;

  // StoryData holds all of this metadata, so a field it leaves out gets its default, not the
  // value of an earlier StoryData passage. The StorySettings IFID is kept apart (legacyIFID).
  const twine2 = defaultTwine2Metadata();
  story.ifid = typeof data.ifid === 'string' ? normalizeIFID(data.ifid) : ('' as IFID);
  if (typeof data.format === 'string') twine2.format = data.format;
  if (typeof data['format-version'] === 'string') twine2.formatVersion = data['format-version'];
  if (Array.isArray(data.options)) {
    for (const opt of data.options) {
      if (typeof opt === 'string') twine2.options.set(opt, true);
    }
  }
  if (typeof data.start === 'string') twine2.start = data.start;
  if (typeof data.tags === 'string') twine2.tags = data.tags;
  if (typeof data['tag-colors'] === 'object' && data['tag-colors'] !== null && !Array.isArray(data['tag-colors'])) {
    for (const [tag, color] of Object.entries(data['tag-colors'])) {
      if (typeof color === 'string') twine2.tagColors.set(tag, color);
    }
  }
  if (typeof data.zoom === 'number' && data.zoom !== 0) twine2.zoom = data.zoom;
  story.twine2 = twine2;

  return null;
}

// --- StorySettings (legacy) ---

export function unmarshalStorySettings(story: Story, text: string, diagnostics: Diagnostic[]): void {
  const obsolete: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      diagnostics.push({
        level: 'warning',
        message: `Malformed "StorySettings" entry; skipping "${line}".`,
      });
      continue;
    }

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line
      .slice(colonIdx + 1)
      .trim()
      .toLowerCase();

    switch (key) {
      case 'ifid': {
        const err = validateIFID(val);
        if (err === null) {
          story.legacyIFID = normalizeIFID(val);
        }
        obsolete.push('"ifid"');
        continue;
      }
      case 'zoom':
        obsolete.push('"zoom"');
        continue;
      default:
        // Any other key is a setting.
        break;
    }

    story.twine1.settings.set(key, val);
  }

  if (obsolete.length > 0) {
    const entries = obsolete.length === 1 ? 'entry' : 'entries';
    const pronoun = obsolete.length === 1 ? 'it' : 'them';
    diagnostics.push({
      level: 'warning',
      message:
        `Detected obsolete "StorySettings" ${entries}: ${obsolete.join(', ')}. ` +
        `Please remove ${pronoun} from the "StorySettings" special passage.`,
    });
  }
}

/**
 * Process a passage and add it to the story, handling special passages.
 * Creates new passage objects where text is modified rather than mutating the input.
 *
 * A passage replaces an earlier one with the same name, except where either name was generated
 * (see `withGeneratedName()`): a generated name never replaces a passage and is never replaced.
 * A passage with a generated name takes the first free name of `base`, `base 2`, … when its own
 * is taken or is a compiler special name. A passage with a name from the sources that a generated
 * name holds takes it over, and the generated one moves to the first free name in its place.
 */
export function storyAdd(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  const origin = generatedNames.get(p);
  if (origin !== undefined) {
    addGenerated(story, p, origin, diagnostics);
    return;
  }
  moveGeneratedAside(story, p.name, diagnostics);

  let processed = p;

  switch (p.name) {
    case 'StoryIncludes':
      diagnostics.push({
        level: 'warning',
        message:
          'Ignoring "StoryIncludes" compiler special passage; twee-ts allows you to specify project files and/or directories to recursively search.',
      });
      break;

    case 'StoryData': {
      const err = unmarshalStoryData(story, p.text);
      if (err === null) {
        // Validate the IFID if present.
        if (story.ifid.length > 0) {
          const vErr = validateIFID(story.ifid);
          if (vErr !== null) {
            diagnostics.push({
              level: 'error',
              message: `Cannot validate IFID; ${vErr}.`,
            });
          }
        }
        // Rebuild passage contents to normalize.
        processed = { ...p, text: marshalStoryData(story) };
      } else {
        diagnostics.push({
          level: 'warning',
          message: `Cannot unmarshal "StoryData" compiler special passage; ${err}.`,
        });
      }
      break;
    }

    case 'StorySettings':
      unmarshalStorySettings(story, p.text, diagnostics);
      break;

    case 'StoryTitle': {
      const trimmed = p.text.trim();
      processed = { ...p, text: trimmed };
      story.name = trimmed;
      break;
    }

    default:
      // Any other name is an ordinary passage.
      break;
  }

  storyAppend(story, processed, diagnostics);
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

/**
 * Builder that separates the mutable construction phase from the immutable consumption phase.
 * During construction, the internal `Story` is mutable via `add()` and direct access: you may
 * push, splice, sort, rename or reassign `story.passages` between calls, and `add()` and `has()`
 * see the passages as they are then.
 * After `build()`, the story is returned as `ReadonlyStory`.
 */
export class StoryBuilder {
  /** The mutable story, accessible during construction for loader functions. */
  readonly story: Story;

  constructor() {
    this.story = createStory();
  }

  /** Add a passage, handling special passages (StoryData, StoryTitle, etc.). */
  add(passage: Passage, diagnostics: Diagnostic[]): void {
    // A found name is checked at its position, so it is current. Only a new name (or a generated
    // one, which looks up other names) needs every position checked first.
    if (generatedNames.has(passage) || !storyHas(this.story, passage.name)) storyVerifyIndex(this.story);
    storyAdd(this.story, passage, diagnostics);
  }

  /** Check if a passage name exists. */
  has(name: string): boolean {
    // A found name is checked at its position; only "not found" needs every position checked.
    if (storyHas(this.story, name)) return true;
    storyVerifyIndex(this.story);
    return storyHas(this.story, name);
  }

  /** Finalize and return the story as read-only. */
  build(): ReadonlyStory {
    return this.story;
  }
}
