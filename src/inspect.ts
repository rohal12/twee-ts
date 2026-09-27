/**
 * Story inspection utilities for unit testing.
 *
 * Extracts structural information from a compiled story:
 * passage names, tags, link graph, broken links, dead ends, orphans.
 *
 * Usage:
 *   const result = await compile({ sources: ['./story'] });
 *   const map = storyInspect(result.story);
 *   expect(map.passages).toContain('Start');
 *   expect(map.brokenLinks).toHaveLength(0);
 */
import type { ReadonlyPassage, ReadonlyStory } from './types.js';
import { hasTag, isInfoPassage, isStoryPassage } from './passage.js';
import { findJavaScriptPassageLinks, findMacroPassageLinks } from './sugarcube-macros.js';

export interface StoryMap {
  /** All passage names, in source order. */
  passages: string[];
  /** Only story passages (excludes StoryData, StoryTitle, scripts, stylesheets, etc.). */
  storyPassages: string[];
  /** Only info/special passages. */
  infoPassages: string[];
  /** All unique tags used across the story, sorted alphabetically. */
  tags: string[];
  /** Map of tag → passage names that carry that tag. */
  passagesByTag: Map<string, string[]>;
  /** Map of passage name → tags on that passage. */
  tagsByPassage: Map<string, string[]>;
  /**
   * Map of passage name → passage names it links to.
   * Parses `[[target]]`, `[[display->target]]`, `[[display|target]]`,
   * and SugarCube's `<<goto "target">>` / `<<link "display" "target">>`,
   * whose arguments are read as SugarCube 2 reads them (see `sugarcube-macros.ts`).
   */
  links: Map<string, string[]>;
  /** Broken links: `{ from, to }` pairs where `to` doesn't exist as a passage. */
  brokenLinks: BrokenLink[];
  /** Story passages with no outgoing links (potential dead ends). */
  deadEnds: string[];
  /** Story passages that no other passage links to (excluding the start passage). */
  orphans: string[];
  /** The configured start passage name, if any. */
  start: string;
}

export interface BrokenLink {
  from: string;
  to: string;
}

/**
 * Extract all [[wiki-style links]] from passage text.
 *
 * Supported syntaxes:
 * - `[[PassageName]]`
 * - `[[Display Text->PassageName]]`  (Twine 2 / SugarCube arrow)
 * - `[[Display Text|PassageName]]`   (Twine 1 / Harlowe pipe)
 * - `<<goto "PassageName">>`         (SugarCube macro)
 * - `<<link "Display" "PassageName">>`  (SugarCube macro)
 *
 * SugarCube macro arguments may be double- or single-quoted, with backslash escapes, or bare
 * words; a passage named by a variable or an expression is known only in play and is skipped.
 * Macro calls are also read inside the quoted strings of other macros' arguments, and inside the
 * strings of `<<script>>` bodies and `<script>` elements; calls in comments are not read. A
 * script passage (`isScript`) is JavaScript, so its macro calls are read only inside its strings.
 * See `sugarcube-macros.ts` for the details and the known differences from SugarCube.
 */
function extractLinksFromText(text: string, isScript: boolean): string[] {
  const targets = new Set<string>();

  // [[...]] links
  const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = wikiLinkRe.exec(text)) !== null) {
    const content = m[1]!;

    // [[display->target]]
    const arrowIdx = content.indexOf('->');
    if (arrowIdx !== -1) {
      targets.add(content.slice(arrowIdx + 2).trim());
      continue;
    }

    // [[display|target]]
    const pipeIdx = content.indexOf('|');
    if (pipeIdx !== -1) {
      targets.add(content.slice(pipeIdx + 1).trim());
      continue;
    }

    // [[target]]
    targets.add(content.trim());
  }

  // <<goto "target">> and <<link "display" "target">>. Gotos come before links, the order
  // this list has always had.
  const macroLinks = isScript ? findJavaScriptPassageLinks(text) : findMacroPassageLinks(text);
  for (const macro of ['goto', 'link'] as const) {
    for (const link of macroLinks) {
      if (link.macro === macro) {
        targets.add(link.passage);
      }
    }
  }

  return [...targets];
}

/** Passages SugarCube runs from their raw text, never joining their lines. */
const RAW_TEXT_PASSAGES: ReadonlySet<string> = new Set(['StoryInit', 'PassageReady', 'PassageDone']);

/**
 * A passage's text as SugarCube reads it for its links. A passage tagged `nobr` has its line
 * breaks joined (`Passage.processText`): leading and trailing ones removed, each run inside made
 * one space. Script passages, `init`-tagged passages, StoryInit, PassageReady and PassageDone are
 * run from their raw text, so they keep theirs.
 */
function textAsRead(p: ReadonlyPassage): string {
  const joined = hasTag(p, 'nobr') && !hasTag(p, 'script') && !hasTag(p, 'init') && !RAW_TEXT_PASSAGES.has(p.name);
  return joined ? joinLines(p.text) : p.text;
}

/**
 * What SugarCube's `text.replace(/^\n+|\n+$/g, '').replace(/\n+/g, ' ')` gives, without that
 * pattern's backtracking, which takes quadratic time on a long run of line feeds.
 */
function joinLines(text: string): string {
  let start = 0;
  while (text[start] === '\n') {
    start += 1;
  }
  let end = text.length;
  while (end > start && text[end - 1] === '\n') {
    end -= 1;
  }
  return text.slice(start, end).replace(/\n+/g, ' ');
}

/**
 * Inspect a story and return its full structural map.
 *
 * Designed for story authors to use in unit tests:
 * ```ts
 * const result = await compile({ sources: ['./story'] });
 * const map = storyInspect(result.story);
 *
 * // Assert structure
 * expect(map.passages).toContain('Start');
 * expect(map.tags).toContain('location');
 * expect(map.passagesByTag.get('location')).toContain('Kitchen');
 * expect(map.brokenLinks).toEqual([]);
 * expect(map.deadEnds).not.toContain('Start');
 * ```
 */
export function storyInspect(story: ReadonlyStory): StoryMap {
  const allNames = new Set(story.passages.map((p) => p.name));

  const passages: string[] = [];
  const storyPassages: string[] = [];
  const infoPassages: string[] = [];
  const tagSet = new Set<string>();
  const passagesByTag = new Map<string, string[]>();
  const tagsByPassage = new Map<string, string[]>();
  const links = new Map<string, string[]>();

  for (const p of story.passages) {
    passages.push(p.name);

    if (isStoryPassage(p)) {
      storyPassages.push(p.name);
    }
    if (isInfoPassage(p)) {
      infoPassages.push(p.name);
    }

    // Tags
    tagsByPassage.set(p.name, [...p.tags]);
    for (const tag of p.tags) {
      tagSet.add(tag);
      let list = passagesByTag.get(tag);
      if (!list) {
        list = [];
        passagesByTag.set(tag, list);
      }
      list.push(p.name);
    }

    // Links
    const targets = extractLinksFromText(textAsRead(p), hasTag(p, 'script'));
    links.set(p.name, targets);
  }

  // Broken links: link targets that don't exist as passages
  const brokenLinks: BrokenLink[] = [];
  for (const [from, targets] of links) {
    for (const to of targets) {
      if (!allNames.has(to)) {
        brokenLinks.push({ from, to });
      }
    }
  }

  // Dead ends: story passages with no outgoing links
  const deadEnds: string[] = [];
  for (const name of storyPassages) {
    const targets = links.get(name);
    if (!targets || targets.length === 0) {
      deadEnds.push(name);
    }
  }

  // Orphans: story passages nobody links to (excluding start)
  const start = story.twine2.start || 'Start';
  const linkedTo = new Set<string>();
  for (const targets of links.values()) {
    for (const t of targets) {
      linkedTo.add(t);
    }
  }
  const orphans: string[] = [];
  for (const name of storyPassages) {
    if (name !== start && !linkedTo.has(name)) {
      orphans.push(name);
    }
  }

  return {
    passages,
    storyPassages,
    infoPassages,
    tags: [...tagSet].sort(),
    passagesByTag,
    tagsByPassage,
    links,
    brokenLinks,
    deadEnds,
    orphans,
    start,
  };
}
