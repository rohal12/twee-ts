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
import type { InspectOptions, PassageOmission, ReadonlyPassage, ReadonlyStory } from './types.js';
import { hasTag, isInfoPassage, isStoryPassage } from './passage.js';
import { passageOmission } from './passage-omission.js';
import { findJavaScriptPassageLinks, findPassageLinks } from './sugarcube-macros.js';

export interface StoryMap {
  /** All passage names, in source order. */
  readonly passages: readonly string[];
  /** Only story passages (excludes StoryData, StoryTitle, scripts, stylesheets, etc.). */
  readonly storyPassages: readonly string[];
  /** Only info/special passages. */
  readonly infoPassages: readonly string[];
  /** All unique tags used across the story, sorted alphabetically. */
  readonly tags: readonly string[];
  /** Map of tag → passage names that carry that tag, each listed once even if the tag is repeated. */
  readonly passagesByTag: ReadonlyMap<string, readonly string[]>;
  /** Map of passage name → tags on that passage, as written (a repeated tag appears twice). */
  readonly tagsByPassage: ReadonlyMap<string, readonly string[]>;
  /**
   * Map of passage name → passage names it links to.
   * Parses `[[target]]`, `[[display->target]]`, `[[target<-display]]`, `[[display|target]]`,
   * each with or without a setter (`[[display|target][$x to 1]]`), and SugarCube's
   * `<<goto "target">>` / `<<link "display" "target">>`, read as SugarCube 2 reads them
   * (see Story Inspection in docs/api.md). Links and calls in comments are not read. A script passage is
   * read for links only in its strings; a stylesheet passage (including a loaded `.css` file) is
   * CSS and links to nothing. With a `target` (see `InspectOptions`), a passage that output leaves
   * out links to nothing, except a script passage, which Twine 2 output runs.
   */
  readonly links: ReadonlyMap<string, readonly string[]>;
  /**
   * Broken links: `{ from, to }` pairs where `to` doesn't exist as a passage, or, with a `target`
   * (see `InspectOptions`), where that output leaves the `to` passage out (`omission` says why).
   */
  readonly brokenLinks: readonly BrokenLink[];
  /** Story passages with no outgoing links (potential dead ends). */
  readonly deadEnds: readonly string[];
  /**
   * Story passages that the player cannot reach: no chain of links leads to them from the start passage or
   * from an info passage (such as StoryInit, PassageHeader, or a `script` or `widget` passage, which the story
   * format runs or shows without a link). A passage that links only to itself, or a group that links only
   * among itself, is an orphan. Only the links `links` lists count, so a passage that is shown only through a
   * macro such as `<<include>>` is listed too.
   */
  readonly orphans: readonly string[];
  /** The configured start passage name, if any. */
  readonly start: string;
}

export interface BrokenLink {
  readonly from: string;
  readonly to: string;
  /**
   * Set when a passage named `to` exists, but the inspected output leaves it out of the story
   * (only with a `target`): why it is left out. Absent when no passage has the name.
   */
  readonly omission?: PassageOmission;
}

/**
 * Extract the passages that passage text links to, read as SugarCube 2 reads them.
 *
 * Supported syntaxes:
 * - `[[PassageName]]`
 * - `[[Display Text|PassageName]]`
 * - `[[Display Text->PassageName]]`
 * - `[[PassageName<-Display Text]]`
 * - any of those with a setter: `[[Display Text|PassageName][$x to 1]]`
 * - `<<goto "PassageName">>`            (SugarCube macro)
 * - `<<link "Display" "PassageName">>`  (SugarCube macro)
 *
 * In link markup, the first `|`, `->` or `<-` divides the text from the passage name; image
 * markup (`[img[…][PassageName]]`) is not read. SugarCube macro arguments may be double- or
 * single-quoted, with backslash escapes, or bare words; a passage named by a variable or an
 * expression is known only in play and is skipped. Links and macro calls are also read inside the
 * quoted strings of macros' arguments, and inside the strings of `<<script>>` bodies and
 * `<script>` elements; links and calls in comments are not read. A script passage (`isScript`) is
 * JavaScript, so its links and calls are read only inside its strings. See `sugarcube-macros.ts`
 * for the details and the known differences from SugarCube.
 */
function extractLinksFromText(text: string, isScript: boolean): string[] {
  const found = isScript ? findJavaScriptPassageLinks(text) : findPassageLinks(text);
  // Link markup, then gotos, then links: the order this list has always had.
  const ordered = (['markup', 'goto', 'link'] as const).flatMap((via) =>
    found.filter((link) => link.via === via).map((link) => link.passage),
  );
  return [...new Set(ordered)];
}

/**
 * The passages that `p` links to. A script passage is JavaScript, read for links only in its
 * strings. A stylesheet is CSS, which the story puts in a style element and never wikifies, so it
 * links nowhere; a passage tagged both is a script, as Twine 2 output takes it.
 */
function passageLinks(p: ReadonlyPassage): string[] {
  if (hasTag(p, 'script')) return extractLinksFromText(textAsRead(p), true);
  if (hasTag(p, 'stylesheet')) return [];
  return extractLinksFromText(textAsRead(p), false);
}

/**
 * Whether the `target` output keeps the links in `p`: always without a target, which describes
 * every source passage. With one, a passage the output leaves out never reaches the player, so it
 * links nowhere, except a script passage, which Twine 2 output leaves out as a passage but runs.
 */
function readsLinks(story: ReadonlyStory, p: ReadonlyPassage, { target }: InspectOptions): boolean {
  if (target === undefined) return true;
  const omission = passageOmission(story, p, target);
  return omission === undefined || (omission.kind === 'tag' && omission.tag === 'script');
}

/**
 * Each passage name, mapped to why the `target` output leaves that passage out, or to `undefined`
 * when a link can reach it: always without a target, and otherwise when the output emits a
 * passage of that name.
 */
function destinationOmissions(
  story: ReadonlyStory,
  { target }: InspectOptions,
): ReadonlyMap<string, PassageOmission | undefined> {
  const omissions = new Map<string, PassageOmission | undefined>();
  for (const p of story.passages) {
    const omission = target === undefined ? undefined : passageOmission(story, p, target);
    // One emitted passage of a name is enough for a link to reach it.
    if (!omissions.has(p.name) || omission === undefined) {
      omissions.set(p.name, omission);
    }
  }
  return omissions;
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

/** The passage names that `roots` and the passages their links lead to, link after link, reach. Linear. */
function reachable(roots: readonly string[], links: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const reached = new Set(roots);
  const pending = [...reached];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    for (const target of links.get(name) ?? []) {
      if (reached.has(target)) continue;
      reached.add(target);
      pending.push(target);
    }
  }
  return reached;
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
 *
 * By default, a link is broken only when no passage has its name. Pass a `target` to check links
 * against what that output emits: `storyInspect(result.story, { target: 'twine2' })` also reports
 * links to passages Twine 2 output leaves out, such as script, stylesheet and `Twine.private`
 * passages. With a target, passages that output leaves out also give no links (script passages
 * excepted, as Twine 2 output runs them), so they report no broken links and keep no passage from
 * being an orphan.
 */
export function storyInspect(story: ReadonlyStory, options: InspectOptions = {}): StoryMap {
  const destinations = destinationOmissions(story, options);

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
    // A tag written twice still lists the passage once.
    for (const tag of new Set(p.tags)) {
      tagSet.add(tag);
      let list = passagesByTag.get(tag);
      if (!list) {
        list = [];
        passagesByTag.set(tag, list);
      }
      list.push(p.name);
    }

    // Links
    links.set(p.name, readsLinks(story, p, options) ? passageLinks(p) : []);
  }

  // Broken links: link targets that don't exist as passages, or that the target output leaves out
  const brokenLinks: BrokenLink[] = [];
  for (const [from, targets] of links) {
    for (const to of targets) {
      if (!destinations.has(to)) {
        brokenLinks.push({ from, to });
        continue;
      }
      const omission = destinations.get(to);
      if (omission !== undefined) {
        brokenLinks.push({ from, to, omission });
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

  // Orphans: story passages that no chain of links reaches from the start or from an info passage
  const start = story.twine2.start || 'Start';
  const reached = reachable([start, ...infoPassages], links);
  const orphans = storyPassages.filter((name) => !reached.has(name));

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
