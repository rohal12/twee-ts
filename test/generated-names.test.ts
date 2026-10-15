import { describe, expect, it, vi } from 'vitest';
import { decompileHTML } from '../src/html-parser.js';
import { moduleIds } from '../src/modules.js';
import { withGeneratedName } from '../src/passage.js';
import { createStory, storyAdd, storyGet, storyPrepend } from '../src/story.js';
import type { Diagnostic, Passage } from '../src/types.js';

function generated(base: string, text = ''): Passage {
  return withGeneratedName({ name: base, tags: ['script'], text }, { kind: 'code', base });
}

describe('generated name allocation (#460)', () => {
  it('does bounded name checks when many generated passages share a base', () => {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    const has = vi.spyOn(Set.prototype, 'has');
    let checks: number;
    try {
      for (let i = 0; i < 500; i++) storyAdd(story, generated('Code'), diagnostics);
      checks = has.mock.calls.length;
    } finally {
      has.mockRestore();
    }
    expect(story.passages).toHaveLength(500);
    expect(story.passages.at(-1)?.name).toBe('Code 500');
    expect(checks).toBeLessThan(5_000);
    expect(diagnostics).toEqual([]);
  });

  it('does bounded name checks when many modules share a base', () => {
    const idFor = moduleIds();
    const has = vi.spyOn(Map.prototype, 'has');
    let checks: number;
    let last = '';
    try {
      for (let i = 0; i < 500; i++) last = idFor('script-module-ui', `file-${String(i)}.js`);
      checks = has.mock.calls.length;
    } finally {
      has.mockRestore();
    }
    expect(last).toBe('script-module-ui-500');
    expect(checks).toBeLessThan(2_000);
  });

  it.each(['script', 'style', 'StoryData', 'StoryTitle'] as const)(
    'does bounded name checks for repeated HTML %s elements',
    (kind) => {
      const child =
        kind === 'script' || kind === 'style'
          ? `<${kind}>a{}</${kind}>`
          : `<tw-passagedata name="${kind}">ordinary</tw-passagedata>`;
      const html = `<tw-storydata>${child.repeat(500)}</tw-storydata>`;
      const has = vi.spyOn(Set.prototype, 'has');
      let checks: number;
      let result: ReturnType<typeof decompileHTML>;
      try {
        result = decompileHTML(html);
        checks = has.mock.calls.length;
      } finally {
        has.mockRestore();
      }
      expect(result.story.passages).toHaveLength(501);
      expect(checks).toBeLessThan(15_000);
    },
  );

  it('does bounded passage reads and name checks when authored passages take generated names', () => {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    for (let i = 0; i < 500; i++) storyAdd(story, generated('Code', String(i)), diagnostics);
    const names = story.passages.map((p) => p.name);
    let reads = 0;
    story.passages = new Proxy(story.passages, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const has = vi.spyOn(Set.prototype, 'has');
    let checks: number;
    try {
      for (const name of names) storyAdd(story, { name, tags: [], text: 'authored' }, diagnostics);
      checks = has.mock.calls.length;
    } finally {
      has.mockRestore();
    }
    expect(story.passages).toHaveLength(1_000);
    expect(storyGet(story, 'Code 501')?.text).toBe('0');
    expect(storyGet(story, 'Code 1000')?.text).toBe('499');
    expect(storyGet(story, 'Code 2')?.text).toBe('authored');
    expect(reads).toBeLessThan(20_000);
    expect(checks).toBeLessThan(5_000);
    expect(diagnostics).toEqual([]);
  });

  it('keeps the first free suffix across pre-reservations, overlapping bases, and authored takeovers', () => {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    storyAdd(story, { name: 'Code 3', tags: [], text: 'reserved' }, diagnostics);
    for (const base of ['Code', 'Code', 'Code 2', 'Code 2', 'Code']) storyAdd(story, generated(base), diagnostics);
    storyAdd(story, { name: 'Code 2', tags: [], text: 'authored' }, diagnostics);
    storyPrepend(story, { name: 'Code 2 2', tags: [], text: 'front' }, diagnostics);
    expect(story.passages.map((p) => p.name)).toEqual([
      'Code 2 2',
      'Code 3',
      'Code',
      'Code 5',
      'Code 2 4',
      'Code 2 3',
      'Code 4',
      'Code 2',
    ]);
    expect(diagnostics).toEqual([]);
  });

  it.each(['reassign', 'resize'] as const)('reuses a freed earlier suffix after an array %s', (change) => {
    const story = createStory();
    const diagnostics: Diagnostic[] = [];
    for (let i = 0; i < 4; i++) storyAdd(story, generated('Code'), diagnostics);
    if (change === 'reassign') story.passages = story.passages.filter((p) => p.name !== 'Code 2');
    else story.passages.splice(1, 1);
    storyAdd(story, generated('Code'), diagnostics);
    expect(story.passages.at(-1)?.name).toBe('Code 2');
    expect(diagnostics).toEqual([]);
  });

  it('keeps module suffixes unique when bases overlap and identifies the first owner', () => {
    const diagnostics: Diagnostic[] = [];
    const idFor = moduleIds(diagnostics);
    const ids = ['ui', 'ui-2', 'ui', 'ui-2', 'ui'].map((base, i) => idFor(base, `${String(i)}.js`));
    expect(ids).toEqual(['ui', 'ui-2', 'ui-3', 'ui-2-2', 'ui-4']);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'The modules "0.js" and "2.js" would both have the element id "ui"; "2.js" has the id "ui-3" instead.',
      'The modules "1.js" and "3.js" would both have the element id "ui-2"; "3.js" has the id "ui-2-2" instead.',
      'The modules "0.js" and "4.js" would both have the element id "ui"; "4.js" has the id "ui-4" instead.',
    ]);
  });
});
