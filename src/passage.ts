/**
 * Passage helpers and output methods.
 * Ported from passage.go / passagedata.go.
 */
import type { Passage, ReadonlyPassage, PassageMetadata, OutputMode, WordCountMethod } from './types.js';
import { attrEscape, fullAttrEscape, htmlEscape, tiddlerEscape, rot13 } from './escape.js';
import { tweeEscape } from './twee-syntax.js';
import { countTextWords } from './word-count.js';
import type { DecodeIssue, FieldReader, TextDecodeResult } from './json-decode.js';
import { jsonString, nullAsZero, ownRecord, readObjectText, formatJsonPath } from './json-decode.js';

// Info passages contain structural data, metadata, and code rather than story content.
const INFO_PASSAGE_NAMES = new Set([
  'StoryAuthor',
  'StoryInit',
  'StoryMenu',
  'StorySubtitle',
  'StoryTitle',
  'PassageReady',
  'PassageDone',
  'PassageHeader',
  'PassageFooter',
  'StoryBanner',
  'StoryCaption',
  'StoryDisplayTitle',
  'MenuOptions',
  'MenuShare',
  'MenuStory',
  'StoryInterface',
  'StoryShare',
  'StorySettings',
  'StoryData',
  'StoryIncludes',
]);

const INFO_TAGS = ['annotation', 'init', 'script', 'stylesheet', 'widget'];

export function hasTag(p: ReadonlyPassage, tag: string): boolean {
  return p.tags.includes(tag);
}

function hasAnyTag(p: ReadonlyPassage, ...tags: string[]): boolean {
  return p.tags.some((t) => tags.includes(t));
}

function hasTagStartingWith(p: ReadonlyPassage, prefix: string): boolean {
  return p.tags.some((t) => t.startsWith(prefix));
}

function hasInfoTags(p: ReadonlyPassage): boolean {
  return hasAnyTag(p, ...INFO_TAGS) || hasTagStartingWith(p, 'Twine.');
}

function hasInfoName(p: ReadonlyPassage): boolean {
  return INFO_PASSAGE_NAMES.has(p.name);
}

export function isInfoPassage(p: ReadonlyPassage): boolean {
  return hasInfoName(p) || hasInfoTags(p);
}

export function isStoryPassage(p: ReadonlyPassage): boolean {
  return !hasInfoName(p) && !hasInfoTags(p);
}

function hasMetadataPosition(p: ReadonlyPassage): boolean {
  return p.metadata?.position != null && p.metadata.position !== '';
}

function hasMetadataSize(p: ReadonlyPassage): boolean {
  return p.metadata?.size != null && p.metadata.size !== '';
}

/**
 * The metadata entries that are written out: those with a non-empty string value, in their order. An empty
 * value stands for no value, as in Tweego.
 */
function writtenMetadata(meta: Readonly<PassageMetadata> | undefined): [string, string][] {
  return Object.entries(meta ?? {}).flatMap(([key, value]) =>
    typeof value === 'string' && value ? [[key, value]] : [],
  );
}

/**
 * Passage metadata as it is written out (in Twee 3 headers and JSON output): the entries with a value, as own
 * properties (so `__proto__` is kept), or undefined when there are none.
 */
export function metadataForOutput(meta: Readonly<PassageMetadata> | undefined): Record<string, string> | undefined {
  const entries = writtenMetadata(meta);
  return entries.length > 0 ? ownRecord(entries) : undefined;
}

/** The metadata fields Tweego reads; any other key is a twee-ts extension, kept when its value is a string. */
const KNOWN_METADATA_FIELDS = ['position', 'size'] as const;

/** The metadata read; its issues are about values left out or keys read as another, none of them fatal. */
type MetadataDecodeResult = TextDecodeResult<{ readonly metadata: PassageMetadata }>;

/**
 * Decode a passage metadata block (`{"position":"600,400"}`), as Tweego decodes it into its struct:
 *
 * - `position` and `size` must be strings (`null` reads as empty). Their keys match regardless of letter case,
 *   as Go matches struct fields (`Position` is `position`, with an issue saying so); a repeated key takes the
 *   last value. A wrong-typed `position` or `size` makes the whole block unusable (`ok: false`), as in Tweego.
 * - Other keys are kept when their value is a string (Tweego drops them); another value is left out, with an
 *   issue.
 * - Text that is not a JSON object is unusable.
 *
 * Keys are stored as own properties, so `__proto__` and `constructor` are kept like any other key.
 */
export function decodePassageMetadata(json: string): MetadataDecodeResult {
  const entries = new Map<string, string>();
  // Why a known field could not be read; any such field makes the block unusable.
  const rejected: string[] = [];
  const knownField = (name: string): FieldReader => ({
    read(value, path) {
      const fieldIssues: DecodeIssue[] = [];
      const r = nullAsZero(jsonString, '')(value, path, fieldIssues);
      if (r.ok) entries.set(name, r.value);
      rejected.push(...fieldIssues.map((issue) => issue.message));
    },
  });
  const read = readObjectText(json, {
    fields: Object.fromEntries(KNOWN_METADATA_FIELDS.map((name) => [name, knownField(name)])),
    keys: 'go',
    unknown(member, path, memberIssues) {
      if (entries.has(member.key)) {
        memberIssues.push({
          kind: 'duplicate-key',
          path,
          message: `${formatJsonPath(path)} repeats a key; the last one is used`,
        });
      }
      const r = nullAsZero(jsonString, '')(member.value, path, memberIssues);
      if (r.ok) entries.set(member.key, r.value);
      else entries.delete(member.key);
    },
  });
  if (!read.ok) return read;
  if (rejected.length > 0) return { ok: false, reason: rejected.join('; ') };
  return { ok: true, metadata: ownRecord(entries), issues: read.issues };
}

/** Convert passage to Twee source. */
export function passageToTwee(p: ReadonlyPassage, outMode: OutputMode): string {
  let output: string;
  if (outMode === 'twee3') {
    output = ':: ' + tweeEscape(p.name);
    if (p.tags.length > 0) {
      output += ' [' + tweeEscape(p.tags.join(' ')) + ']';
    }
    const metadata = metadataForOutput(p.metadata);
    if (metadata !== undefined) output += ' ' + JSON.stringify(metadata);
  } else {
    output = ':: ' + p.name;
    if (p.tags.length > 0) {
      output += ' [' + p.tags.join(' ') + ']';
    }
  }
  output += '\n';
  if (p.text.length > 0) {
    output += p.text + '\n';
  }
  output += '\n\n';
  return output;
}

/** Generate `<tw-passagedata>` HTML for Twine 2. */
export function passageToPassagedata(
  p: ReadonlyPassage,
  pid: number,
  options?: { readonly sourceInfo?: boolean },
): string {
  let position: string;
  let size: string;

  if (hasMetadataPosition(p)) {
    position = p.metadata?.position ?? '';
  } else {
    position = gridPosition(pid, 125, 25);
  }

  if (hasMetadataSize(p)) {
    size = p.metadata?.size ?? '';
  } else {
    size = '100,100';
  }

  let attrs = `<tw-passagedata pid="${pid}" name=${quote(fullAttrEscape(p.name))} tags=${quote(attrEscape(p.tags.join(' ')))} position=${quote(attrEscape(position))} size=${quote(attrEscape(size))}`;
  if (options?.sourceInfo && p.source) {
    attrs += ` data-source-file=${quote(attrEscape(p.source.file))} data-source-line="${p.source.line}"`;
  }
  return `${attrs}>${htmlEscape(p.text)}</tw-passagedata>`;
}

/**
 * Where Twine lays out passage `pid` (from 1) that has no position of its own: in rows of ten, `cell` apart,
 * the first `cell - inset` from the top left corner (Twine 2: 125 and 25; Twine 1: 140 and 130).
 */
function gridPosition(pid: number, cell: number, inset: number): string {
  const x = pid % 10;
  const y = Math.floor(pid / 10);
  const column = x === 0 ? 10 : x;
  const row = x === 0 ? y : y + 1;
  return `${column * cell - inset},${row * cell - inset}`;
}

/**
 * Whether Twine 1 `obfuscate:rot13` encodes a tiddler: every one but `StorySettings` and those tagged `Twine.image`
 * (Twine 1.4 `Tiddler.isObfuscateable()`). Its engine tests the stored name and tags, which these tiddlers keep
 * unencoded, so the decompiler tests them the same way.
 */
export function isObfuscatable(p: Pick<ReadonlyPassage, 'name' | 'tags'>): boolean {
  return p.name !== 'StorySettings' && !p.tags.includes('Twine.image');
}

/**
 * Generate `<div tiddler>` HTML for Twine 1. With `obfuscateRot13`, an obfuscatable tiddler (see
 * `isObfuscatable()`) has its name, each tag and its text ROT13-encoded, as Twine 1.4 writes it
 * (`Tiddler.toHtml()`), and as its engine.js decodes it.
 */
export function passageToTiddler(p: ReadonlyPassage, pid: number, obfuscateRot13: boolean, time: Date): string {
  const position = hasMetadataPosition(p) ? (p.metadata?.position ?? '') : gridPosition(pid, 140, 130);

  // Twine 1's form, YYYYMMDDHHMM in UTC; every tiddler of one build has the build's time.
  const created = time.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const encode = obfuscateRot13 && isObfuscatable(p) ? rot13 : (s: string) => s;
  const name = attrEscape(encode(p.name));
  const tags = attrEscape(p.tags.map(encode).join(' '));
  return `<div tiddler=${quote(name)} tags=${quote(tags)} created=${quote(created)} modifier=${quote('twee')} twine-position=${quote(attrEscape(position))}>${tiddlerEscape(encode(p.text))}</div>`;
}

/** Count the words in a passage's text (see `countTextWords` for the methods). */
export function countWords(p: ReadonlyPassage, method: WordCountMethod = 'tweego'): number {
  return countTextWords(p.text, method);
}

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

/**
 * Passages whose names were generated, kept by identity so that cached passages keep the mark. A changed
 * copy of a passage is made with {@link derivePassage}, which carries the mark over.
 */
const generatedNames = new WeakMap<Passage, GeneratedName>();

/**
 * Mark a passage's name as generated (from a file name, or for imported story code) and return
 * the passage. `origin.base` is the name that free names are numbered from: `base`, `base 2`, ….
 */
export function withGeneratedName(p: Passage, origin: GeneratedName): Passage {
  generatedNames.set(p, origin);
  return p;
}

/** Where the passage's name came from, when the compiler generated it. */
export function generatedNameOf(p: Passage): GeneratedName | undefined {
  return generatedNames.get(p);
}

/**
 * A copy of `p` with `changes` applied: the one way to make a changed copy of a passage while a story is
 * built. What is known about the passage beyond its fields carries over: a generated name stays generated
 * while the name is unchanged. A copy under a new name has an authored name, unless the caller marks it
 * again (as `storyAdd()` does when it moves a generated name aside).
 */
export function derivePassage(
  p: Passage,
  changes: Readonly<Partial<Pick<Passage, 'name' | 'tags' | 'text'>>>,
): Passage {
  const copy: Passage = { ...p, ...changes };
  const origin = generatedNames.get(p);
  if (origin !== undefined && copy.name === p.name) generatedNames.set(copy, origin);
  return copy;
}

/**
 * Freeze `p` and everything it holds (tags, metadata, source), in place, and return it. A frozen passage
 * keeps its identity, so what is known about it by identity (a generated name) stays known.
 */
export function freezePassage(p: Passage): Passage {
  Object.freeze(p.tags);
  if (p.metadata !== undefined) Object.freeze(p.metadata);
  if (p.source !== undefined) Object.freeze(p.source);
  return Object.freeze(p);
}

/**
 * Apply tag aliases: for each passage carrying an alias tag, add the canonical tag if not already present. A
 * canonical tag that is itself an alias is followed (`{ a: 'b', b: 'c' }` adds `b` and `c` to a passage tagged
 * `a`), until no mapping adds anything, so cycles and self-mappings end too. Authored tags keep their place, added
 * tags follow in the order they were reached, and nothing is duplicated. Returns new passage objects where tags
 * changed; unchanged passages are returned as-is. Idempotent: the result carries every tag the mappings reach, so
 * applying the same aliases again adds nothing.
 */
export function applyTagAliases(passages: readonly Passage[], aliases: Readonly<Record<string, string>>): Passage[] {
  const entries = Object.entries(aliases);
  if (entries.length === 0) return [...passages];
  return passages.map((p) => {
    const tags = new Set(p.tags);
    const authored = tags.size;
    for (let grew = true; grew;) {
      const before = tags.size;
      for (const [alias, canonical] of entries) {
        if (tags.has(alias)) tags.add(canonical);
      }
      grew = tags.size > before;
    }
    return tags.size > authored ? derivePassage(p, { tags: [...tags] }) : p;
  });
}

function quote(s: string): string {
  return `"${s}"`;
}
