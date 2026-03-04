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
import type { Story } from './types.js';
import { isInfoPassage, isStoryPassage } from './passage.js';

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
   * and SugarCube's `<<goto "target">>` / `<<link "display" "target">>`.
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
 */
function extractLinksFromText(text: string): string[] {
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

  // <<goto "target">>
  const gotoRe = /<<goto\s+["']([^"']+)["']\s*>>/g;
  while ((m = gotoRe.exec(text)) !== null) {
    targets.add(m[1]!);
  }

  // <<link "display" "target">> (second argument is the target passage)
  const linkMacroRe = /<<link\s+["'][^"']*["']\s+["']([^"']+)["']\s*>>/g;
  while ((m = linkMacroRe.exec(text)) !== null) {
    targets.add(m[1]!);
  }

  return [...targets];
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
export function storyInspect(story: Story): StoryMap {
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
    const targets = extractLinksFromText(p.text);
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
