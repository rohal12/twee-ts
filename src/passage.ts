/**
 * Passage helpers and output methods.
 * Ported from passage.go / passagedata.go.
 */
import type { Passage, ReadonlyPassage, PassageMetadata, OutputMode, WordCountMethod } from './types.js';
import { attrEscape, fullAttrEscape, htmlEscape, tiddlerEscape, tweeEscape, rot13 } from './escape.js';

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
  'MenuOptions',
  'MenuShare',
  'MenuStory',
  'StoryInterface',
  'StoryShare',
  'StorySettings',
  'StoryData',
  'StoryIncludes',
]);

const INFO_TAGS = ['annotation', 'script', 'stylesheet', 'widget'];

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

function hasAnyMetadata(p: ReadonlyPassage): boolean {
  if (!p.metadata) return false;
  return Object.values(p.metadata).some((v) => v != null && v !== '');
}

export function marshalMetadata(meta: PassageMetadata): string {
  const obj: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string' && value) obj[key] = value;
  }
  return JSON.stringify(obj);
}

export function unmarshalMetadata(json: string): PassageMetadata {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const parsed = raw as Record<string, unknown>;
  const meta: PassageMetadata = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') meta[key] = value;
  }
  return meta;
}

/** Convert passage to Twee source. */
export function passageToTwee(p: ReadonlyPassage, outMode: OutputMode): string {
  let output: string;
  if (outMode === 'twee3') {
    output = ':: ' + tweeEscape(p.name);
    if (p.tags.length > 0) {
      output += ' [' + tweeEscape(p.tags.join(' ')) + ']';
    }
    if (hasAnyMetadata(p) && p.metadata) {
      output += ' ' + marshalMetadata(p.metadata);
    }
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
    const x = pid % 10;
    const y = Math.floor(pid / 10);
    const xp = x === 0 ? 10 : x;
    const yp = x === 0 ? y : y + 1;
    position = `${xp * 125 - 25},${yp * 125 - 25}`;
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
export function passageToTiddler(p: ReadonlyPassage, pid: number, obfuscateRot13 = false): string {
  let position: string;

  if (hasMetadataPosition(p)) {
    position = p.metadata?.position ?? '';
  } else {
    const x = pid % 10;
    const y = Math.floor(pid / 10);
    const xp = x === 0 ? 10 : x;
    const yp = x === 0 ? y : y + 1;
    position = `${xp * 140 - 130},${yp * 140 - 130}`;
  }

  const created = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const encode = obfuscateRot13 && isObfuscatable(p) ? rot13 : (s: string) => s;
  const name = attrEscape(encode(p.name));
  const tags = attrEscape(p.tags.map(encode).join(' '));
  return `<div tiddler=${quote(name)} tags=${quote(tags)} created=${quote(created)} modifier=${quote('twee')} twine-position=${quote(attrEscape(position))}>${tiddlerEscape(encode(p.text))}</div>`;
}

/**
 * Count words in a passage.
 *
 * - `'tweego'` (default): Strip newlines, strip comments, count NFKD-normalized characters, divide by 5.
 * - `'whitespace'`: Strip comments and markup, split on whitespace, count tokens.
 */
export function countWords(p: ReadonlyPassage, method: WordCountMethod = 'tweego'): number {
  switch (method) {
    case 'tweego': {
      let text = p.text;
      text = text.replace(/\n/g, '');
      text = text.replace(/(?:\/%.+?%\/|\/\*.+?\*\/|<!--.+?-->)/gs, '');
      const normalized = text.normalize('NFKD');
      // Code points, as Tweego counts runes.
      const count = Array.from(normalized).length;
      if (count === 0) return 0;
      const words = Math.floor(count / 5);
      return count % 5 > 0 ? words + 1 : words;
    }
    case 'whitespace': {
      let text = p.text;
      // Strip comments
      text = text.replace(/(?:\/%.+?%\/|\/\*.+?\*\/|<!--.+?-->)/gs, '');
      // Strip Twine macros <<...>>
      text = text.replace(/<<[^>]*>>/g, '');
      // Strip Twine links [[...]] — keep display text
      text = text.replace(/\[\[([^\]|]*?)(?:\|[^\]]*?)?\]\]/g, '$1');
      // Strip HTML tags
      text = text.replace(/<[^>]+>/g, '');
      const tokens = text.split(/\s+/).filter((t) => t.length > 0);
      return tokens.length;
    }
    default: {
      const _exhaustive: never = method;
      throw new Error(`Unhandled word count method: ${_exhaustive as string}`);
    }
  }
}

/**
 * Apply tag aliases: for each passage carrying an alias tag, add the canonical
 * tag if not already present. Returns new passage objects where tags changed;
 * unchanged passages are returned as-is. Idempotent — safe to call multiple times.
 */
export function applyTagAliases(passages: readonly Passage[], aliases: Record<string, string>): Passage[] {
  const entries = Object.entries(aliases);
  if (entries.length === 0) return [...passages];
  return passages.map((p) => {
    const original = p.tags;
    const added: string[] = [];
    for (const [alias, canonical] of entries) {
      if (original.includes(alias) && !original.includes(canonical) && !added.includes(canonical)) {
        added.push(canonical);
      }
    }
    return added.length > 0 ? { ...p, tags: [...original, ...added] } : p;
  });
}

function quote(s: string): string {
  return `"${s}"`;
}
