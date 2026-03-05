/**
 * Passage helpers and output methods.
 * Ported from passage.go / passagedata.go.
 */
import type { Passage, PassageMetadata, OutputMode } from './types.js';
import { attrEscape, fullAttrEscape, htmlEscape, tiddlerEscape, tweeEscape, rot13, commentSanitize } from './escape.js';

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

export function hasTag(p: Passage, tag: string): boolean {
  return p.tags.includes(tag);
}

export function hasAnyTag(p: Passage, ...tags: string[]): boolean {
  return p.tags.some((t) => tags.includes(t));
}

export function hasTagStartingWith(p: Passage, prefix: string): boolean {
  return p.tags.some((t) => t.startsWith(prefix));
}

export function hasInfoTags(p: Passage): boolean {
  return hasAnyTag(p, ...INFO_TAGS) || hasTagStartingWith(p, 'Twine.');
}

export function hasInfoName(p: Passage): boolean {
  return INFO_PASSAGE_NAMES.has(p.name);
}

export function isInfoPassage(p: Passage): boolean {
  return hasInfoName(p) || hasInfoTags(p);
}

export function isStoryPassage(p: Passage): boolean {
  return !hasInfoName(p) && !hasInfoTags(p);
}

export function hasMetadataPosition(p: Passage): boolean {
  return p.metadata != null && p.metadata.position != null && p.metadata.position !== '';
}

export function hasMetadataSize(p: Passage): boolean {
  return p.metadata != null && p.metadata.size != null && p.metadata.size !== '';
}

export function hasAnyMetadata(p: Passage): boolean {
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
export function passageToTwee(p: Passage, outMode: OutputMode): string {
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
export function passageToPassagedata(p: Passage, pid: number, options?: { readonly sourceInfo?: boolean }): string {
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

/** Generate `<div tiddler>` HTML for Twine 1. */
export function passageToTiddler(p: Passage, pid: number, obfuscateRot13 = false): string {
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
  const content = obfuscateRot13 && p.name !== 'StorySettings' ? tiddlerEscape(rot13(p.text)) : tiddlerEscape(p.text);
  const nameComment = obfuscateRot13 ? `<!-- ${commentSanitize(p.name)} -->` : '';
  return `<div tiddler=${quote(attrEscape(p.name))} tags=${quote(attrEscape(p.tags.join(' ')))} created=${quote(created)} modifier=${quote('twee')} twine-position=${quote(attrEscape(position))}>${nameComment}${content}</div>`;
}

/**
 * Count words in a passage using the Tweego method:
 * Strip newlines, strip comments, count NFKD-normalized characters, divide by 5.
 */
export function countWords(p: Passage): number {
  let text = p.text;
  text = text.replace(/\n/g, '');
  text = text.replace(/(?:\/%.+?%\/|\/\*.+?\*\/|<!--.+?-->)/gs, '');
  // Normalize to NFKD and count characters
  const normalized = text.normalize('NFKD');
  const count = [...normalized].length;
  if (count === 0) return 0;
  const words = Math.floor(count / 5);
  return count % 5 > 0 ? words + 1 : words;
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
