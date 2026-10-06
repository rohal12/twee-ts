/**
 * Passages are values: what a build hands out cannot change what a later build reads (#246 S-4), and
 * what the story model knows about a passage travels with every copy of it (#246 S-5).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Diagnostic, FileCacheEntry, Passage, ReadonlyPassage } from '../src/types.js';
import { compileIncremental } from '../src/compiler.js';
import { applyTagAliases, derivePassage, withGeneratedName } from '../src/passage.js';
import { createStory, storyAdd } from '../src/story.js';

const tmpDirs: string[] = [];

function makeProject(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'twee-ts-passage-identity-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf-8');
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STORY = `:: StoryData
{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}

:: Start [a] {"position":"1,1"}
Hello
`;

/** A passage whose metadata the parser rejects with a warning, which the cache keeps with the file. */
const PARSE_WARNING = `
:: Other {"position":5}
Other
`;

/** Every object a passage holds, so each can be checked for being frozen. */
function partsOf(p: Passage | ReadonlyPassage): object[] {
  return [p, p.tags, ...(p.metadata === undefined ? [] : [p.metadata]), ...(p.source === undefined ? [] : [p.source])];
}

describe('S-4: the incremental cache and the build result share nothing that can change', () => {
  it('freezes the passages and diagnostics a cache entry holds', async () => {
    const dir = makeProject({ 'story.tw': `${STORY}${PARSE_WARNING}` });
    const cache = new Map<string, FileCacheEntry>();
    await compileIncremental({ sources: [dir], outputMode: 'twee3' }, cache);
    const entries = [...cache.values()];
    expect(entries.map((entry) => entry.diagnostics.length)).toEqual([1]);
    for (const entry of entries) {
      expect(Object.isFrozen(entry.passages)).toBe(true);
      expect(Object.isFrozen(entry.diagnostics)).toBe(true);
      for (const p of entry.passages) for (const part of partsOf(p)) expect(Object.isFrozen(part)).toBe(true);
      for (const d of entry.diagnostics) expect(Object.isFrozen(d)).toBe(true);
    }
  });

  it('hands out a frozen story whose passages are not the cached objects', async () => {
    const dir = makeProject({ 'story.tw': STORY });
    const cache = new Map<string, FileCacheEntry>();
    const first = await compileIncremental({ sources: [dir], outputMode: 'twee3' }, cache);
    const cached = new Set<unknown>([...cache.values()].flatMap((entry) => entry.passages));
    expect(Object.isFrozen(first.story)).toBe(true);
    expect(Object.isFrozen(first.story.passages)).toBe(true);
    for (const p of first.story.passages) {
      expect(cached.has(p)).toBe(false);
      for (const part of partsOf(p)) expect(Object.isFrozen(part)).toBe(true);
    }
  });

  it('builds the same output again after a caller tries to change the result and its diagnostics', async () => {
    const dir = makeProject({ 'story.tw': `${STORY}${PARSE_WARNING}` });
    const cache = new Map<string, FileCacheEntry>();
    const options = { sources: [dir], outputMode: 'twee3' as const };
    const first = await compileIncremental(options, cache);
    const start = first.story.passages.find((p) => p.name === 'Start')!;
    // A caller that ignores the readonly types: the writes fail instead of reaching the cache.
    expect(Reflect.set(start, 'text', 'POISONED')).toBe(false);
    expect(Reflect.set(start.tags, 0, 'poisoned')).toBe(false);
    // The diagnostics are the caller's own copies: changing them changes nothing the cache holds.
    const warning = first.diagnostics[0]!;
    expect(warning.level).toBe('warning');
    expect(Reflect.set(warning, 'message', 'POISONED')).toBe(true);
    const second = await compileIncremental(options, cache);
    expect(second.output).toBe(first.output);
    expect(second.output).not.toContain('POISONED');
    expect(second.diagnostics.map((d) => d.message)).not.toContain('POISONED');
    expect(second.diagnostics).toHaveLength(1);
  });
});

describe('S-5: a generated name stays generated in every copy of its passage', () => {
  const media = (): Passage =>
    withGeneratedName(
      { name: 'bg', tags: ['Twine.image'], text: 'data:image/png;base64,AA==' },
      {
        kind: 'media',
        base: 'bg',
        file: 'bg.png',
      },
    );

  /** Adds a passage from the sources named like the generated one: the generated one must move aside. */
  function addSourcePassageOver(passages: readonly Passage[]): { names: string[]; diagnostics: Diagnostic[] } {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    for (const p of passages) storyAdd(story, p, diagnostics);
    storyAdd(story, { name: 'bg', tags: [], text: 'authored' }, diagnostics);
    return { names: story.passages.map((p) => p.name), diagnostics };
  }

  it('keeps the mark through tag aliases', () => {
    const original = media();
    const aliased = applyTagAliases([original], { 'Twine.image': 'picture' })[0]!;
    expect(aliased).not.toBe(original);
    expect(aliased.tags).toEqual(['Twine.image', 'picture']);
    const { names, diagnostics } = addSourcePassageOver([aliased]);
    expect(names).toEqual(['bg 2', 'bg']);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Passage "bg" from "bg.png" renamed to "bg 2"; another passage has the name "bg".',
    ]);
  });

  it('drops the mark from a copy under a new name, whose name is then authored', () => {
    const renamed = derivePassage(media(), { name: 'backdrop' });
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    storyAdd(story, renamed, diagnostics);
    storyAdd(story, { name: 'backdrop', tags: [], text: 'authored' }, diagnostics);
    expect(story.passages.map((p) => [p.name, p.text])).toEqual([['backdrop', 'authored']]);
    expect(diagnostics.map((d) => d.level)).toEqual(['warning']);
  });

  it('keeps the mark through derivePassage, the one way to make a changed copy', () => {
    const copy = derivePassage(media(), { tags: ['Twine.image', 'extra'] });
    expect(copy.tags).toEqual(['Twine.image', 'extra']);
    expect(addSourcePassageOver([copy]).names).toEqual(['bg 2', 'bg']);
  });
});
