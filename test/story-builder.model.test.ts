/**
 * Model-based tests of StoryBuilder (#171): random sequences of add, rename and remove, checked after every
 * step against a plain list, and against what the passages alone decide.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  StoryBuilder,
  createStory,
  deriveStoryMetadata,
  storyAdd,
  storyGet,
  storyHas,
  withGeneratedName,
} from '../src/story.js';
import type { Diagnostic, Story } from '../src/types.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

/** `actual` equals `expected` (for the commands, whose methods are not test blocks). */
function expectEqual(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}

/** Names that make lookups collide with special handling and with object property names. */
const NAMES = [
  'A',
  'B',
  'C',
  'StoryData',
  'StoryTitle',
  'StorySettings',
  'StoryIncludes',
  '__proto__',
  'constructor',
] as const;

/** Texts that the special passages read in different ways, valid and not. */
const TEXTS = [
  'plain',
  `{"ifid":"${IFID}","format":"Harlowe","start":"A","tag-colors":{"__proto__":"red"}}`,
  '{"format":"SugarCube","options":["debug"],"zoom":2}',
  '{"IFID":"bad","Format":7}',
  '{ not json',
  'obfuscate:rot13\nifid:' + IFID,
  'jquery:on',
  '  Spaced Title  ',
] as const;

interface Model {
  /** The passage names, in order. */
  names: string[];
}

type Real = StoryBuilder;

function expectInStep(model: Model, builder: Real): void {
  const story = builder.build();
  expect(story.passages.map((p) => p.name)).toEqual(model.names);
  for (const name of NAMES) {
    // The lookups answer as a linear scan of the passages does.
    expect(builder.has(name)).toBe(model.names.includes(name));
    expect(builder.get(name)?.name).toBe(model.names.includes(name) ? name : undefined);
  }
  // The metadata is what the passages decide.
  const derived = deriveStoryMetadata(story.passages);
  expect({
    name: story.name,
    ifid: story.ifid,
    legacyIFID: story.legacyIFID,
    twine1: story.twine1,
    twine2: story.twine2,
  }).toEqual(derived);
}

class Add implements fc.Command<Model, Real> {
  constructor(
    readonly name: string,
    readonly text: string,
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, builder: Real): void {
    const diagnostics: Diagnostic[] = [];
    const existed = model.names.includes(this.name);
    builder.add({ name: this.name, tags: [], text: this.text }, diagnostics);
    if (!existed) model.names.push(this.name);
    expectEqual(diagnostics.filter((d) => d.message.startsWith('Replacing existing passage')).length, existed ? 1 : 0);
    expectInStep(model, builder);
  }
  toString(): string {
    return `add(${JSON.stringify(this.name)}, ${JSON.stringify(this.text)})`;
  }
}

class Remove implements fc.Command<Model, Real> {
  constructor(readonly name: string) {}
  check(): boolean {
    return true;
  }
  run(model: Model, builder: Real): void {
    const existed = model.names.includes(this.name);
    expectEqual(builder.remove(this.name), existed);
    model.names = model.names.filter((n) => n !== this.name);
    expectInStep(model, builder);
  }
  toString(): string {
    return `remove(${JSON.stringify(this.name)})`;
  }
}

class Rename implements fc.Command<Model, Real> {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, builder: Real): void {
    const diagnostics: Diagnostic[] = [];
    const existed = model.names.includes(this.from);
    expectEqual(builder.rename(this.from, this.to, diagnostics), existed);
    if (existed && this.from !== this.to) {
      const replaced = model.names.includes(this.to);
      model.names = model.names.filter((n) => n !== this.to).map((n) => (n === this.from ? this.to : n));
      expectEqual(
        diagnostics.filter((d) => d.message.startsWith('Replacing existing passage')).length,
        replaced ? 1 : 0,
      );
    }
    expectInStep(model, builder);
  }
  toString(): string {
    return `rename(${JSON.stringify(this.from)}, ${JSON.stringify(this.to)})`;
  }
}

const name = fc.constantFrom(...NAMES);
const commands = [
  fc.tuple(name, fc.constantFrom(...TEXTS)).map(([n, t]) => new Add(n, t)),
  name.map((n) => new Remove(n)),
  fc.tuple(name, name).map(([from, to]) => new Rename(from, to)),
];

describe('StoryBuilder (model-based)', () => {
  it('keeps its lookups, its passage list and its metadata in step through any sequence of changes', () => {
    let sequences = 0;
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 40 }), (cmds) => {
        sequences++;
        fc.modelRun(() => ({ model: { names: [] }, real: new StoryBuilder() }), cmds);
      }),
      { numRuns: 1000 },
    );
    // Each command checks the builder against the model after it runs (see expectInStep).
    expect(sequences).toBeGreaterThanOrEqual(1000);
  });
});

describe('the compiler story functions (model-based)', () => {
  type Step =
    | { readonly kind: 'add'; readonly name: string; readonly text: string }
    | { readonly kind: 'generated'; readonly name: string }
    | { readonly kind: 'reassign' };

  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ kind: fc.constant('add' as const), name, text: fc.constantFrom(...TEXTS) }),
    fc.record({ kind: fc.constant('generated' as const), name }),
    fc.constant({ kind: 'reassign' as const }),
  );

  function apply(story: Story, s: Step): void {
    switch (s.kind) {
      case 'add':
        storyAdd(story, { name: s.name, tags: [], text: s.text }, []);
        return;
      case 'generated':
        storyAdd(
          story,
          withGeneratedName({ name: s.name, tags: ['script'], text: '' }, { kind: 'code', base: s.name }),
          [],
        );
        return;
      case 'reassign':
        // As the compiler does when it applies tag aliases: a new array with new passage objects.
        story.passages = story.passages.map((p) => ({ ...p, tags: [...p.tags, 'alias'] }));
        return;
      default: {
        const _exhaustive: never = s;
        throw new Error(`unhandled step: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  it('answer lookups as a linear scan does, and never hold a name twice, after storyAdd and reassignment', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const story = createStory();
        for (const s of steps) {
          apply(story, s);
          const names = story.passages.map((p) => p.name);
          expect(new Set(names).size).toBe(names.length);
          for (const n of [...NAMES, ...names, 'A 2', 'StoryData 2']) {
            expect(storyHas(story, n)).toBe(names.includes(n));
            expect(storyGet(story, n)).toBe(story.passages.find((p) => p.name === n));
          }
          const { name: title, legacyIFID, twine1, twine2 } = deriveStoryMetadata(story.passages);
          expect({
            name: story.name,
            legacyIFID: story.legacyIFID,
            twine1: story.twine1,
            twine2: story.twine2,
          }).toEqual({
            name: title,
            legacyIFID,
            twine1,
            twine2,
          });
        }
      }),
      { numRuns: 1000 },
    );
  });
});
