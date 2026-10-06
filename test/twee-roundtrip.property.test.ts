/**
 * Property tests for Twee reading and writing: what the writer writes reads back as the same story, or the
 * writer says what will not; and the reader's result does not depend on how the source is split into files,
 * which line endings it has, or byte order marks in front of files.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toTwee } from '../src/output-twee.js';
import { parseTwee } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { StoryBuilder } from '../src/story.js';
import { metadataForOutput } from '../src/passage.js';
import { isHeaderLine, sourceLines, splitTweeFields, trimTweeSpace } from '../src/twee-syntax.js';
import type { Diagnostic, PassageMetadata, ReadonlyPassage, ReadonlyStory } from '../src/types.js';
import { goFoldKey } from '../src/json-decode.js';

/** Characters that matter to Twee syntax, JSON, white space definitions and line breaking. */
const CHARS = [
  'a',
  'B',
  ' ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '[',
  ']',
  '{',
  '}',
  '\\',
  ':',
  '::',
  '"',
  '<',
  '>',
  '|',
  '/',
  '*',
  '\u0000',
  '\u0085',
  '\u00a0',
  '\u2028',
  '\u2029',
  '\ufeff',
  '\ud800',
  '\udc00',
  '😀',
  'é',
];
const anyText = (maxLength: number) => fc.string({ unit: fc.constantFrom(...CHARS), maxLength });

const KEYS = fc.oneof(
  fc.constantFrom('position', 'size', 'Position', '__proto__', 'constructor', 'toString', ''),
  anyText(4),
);

function metadataArbitrary(
  keys: fc.Arbitrary<string>,
  values: fc.Arbitrary<string>,
): fc.Arbitrary<PassageMetadata | undefined> {
  return fc.option(
    fc.uniqueArray(fc.tuple(keys, values), { selector: ([key]) => key, maxLength: 3 }).map((entries) => {
      const metadata: PassageMetadata = {};
      for (const [key, value] of entries) {
        Object.defineProperty(metadata, key, { value, enumerable: true, writable: true, configurable: true });
      }
      return metadata;
    }),
    { nil: undefined },
  );
}

interface PassageInput {
  readonly name: string;
  readonly tags: readonly string[];
  readonly text: string;
  readonly metadata: PassageMetadata | undefined;
}

function storyOf(passages: readonly PassageInput[]): ReadonlyStory {
  const builder = new StoryBuilder();
  for (const p of passages) {
    builder.add({ name: p.name, tags: [...p.tags], text: p.text, ...(p.metadata ? { metadata: p.metadata } : {}) }, []);
  }
  return builder.build();
}

/** A passage as Twee reads it back: its text trimmed (as readers do), its metadata as written. */
function comparable(p: ReadonlyPassage, withMetadata: boolean): unknown {
  return {
    name: p.name,
    tags: [...p.tags],
    text: trimTweeSpace(p.text),
    metadata: withMetadata ? JSON.stringify(metadataForOutput(p.metadata) ?? {}) : '',
  };
}

function expectReadsBack(story: ReadonlyStory, twee: string, withMetadata: boolean): void {
  const { passages, diagnostics } = parseTwee(twee);
  expect(diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  expect(passages.map((p) => comparable(p, withMetadata))).toEqual(
    story.passages.map((p) => comparable(p, withMetadata)),
  );
}

/** Names, tags and texts that Twee can write so that they read back the same. */
const writableName = anyText(8)
  .map((s) => s.replace(/[\r\n]/g, '_'))
  .filter((s) => s !== '' && trimTweeSpace(s) === s);
const writableTag = anyText(4).filter((s) => splitTweeFields(s).length === 1 && splitTweeFields(s)[0] === s);
const writableText = anyText(20)
  .map((s) => s.replace(/\r/g, ''))
  .filter((s) => !sourceLines(s).some(isHeaderLine));

const passageInput = (
  name: fc.Arbitrary<string>,
  tag: fc.Arbitrary<string>,
  text: fc.Arbitrary<string>,
  metadata: fc.Arbitrary<PassageMetadata | undefined>,
): fc.Arbitrary<PassageInput> => fc.record({ name, tags: fc.array(tag, { maxLength: 3 }), text, metadata });

/** Keys that read back as themselves: not a case variant of `position` or `size`, which read as those. */
const writableKey = KEYS.filter(
  (k) => !['POSITION', 'SIZE'].includes(goFoldKey(k)) || k === 'position' || k === 'size',
);

const writableStory = fc.uniqueArray(
  passageInput(writableName, writableTag, writableText, metadataArbitrary(writableKey, anyText(5))),
  { selector: (p) => p.name, minLength: 1, maxLength: 5 },
);

/** Mostly writable values, so that many stories are written without warnings, and some arbitrary ones. */
const mostly = <T>(writable: fc.Arbitrary<T>, any: fc.Arbitrary<T>): fc.Arbitrary<T> =>
  fc.oneof({ arbitrary: writable, weight: 4 }, { arbitrary: any, weight: 1 });

const anyStory = fc.uniqueArray(
  passageInput(
    mostly(writableName, anyText(8)),
    mostly(writableTag, anyText(4)),
    mostly(writableText, anyText(24)),
    metadataArbitrary(mostly(writableKey, KEYS), anyText(5)),
  ),
  {
    selector: (p) => p.name,
    minLength: 1,
    maxLength: 5,
  },
);

describe('Twee 3 output reads back as the same story', () => {
  it('for every story whose names, tags and text Twee can write, with no warning', () => {
    fc.assert(
      fc.property(writableStory, (inputs) => {
        const story = storyOf(inputs);
        const diagnostics: Diagnostic[] = [];
        const twee = toTwee(story, 'twee3', { diagnostics });
        expect(diagnostics).toEqual([]);
        expectReadsBack(story, twee, true);
      }),
      { numRuns: 1000 },
    );
  });

  it('for every story it writes without a warning (the warnings miss nothing)', () => {
    fc.assert(
      fc.property(anyStory, (inputs) => {
        const story = storyOf(inputs);
        const diagnostics: Diagnostic[] = [];
        const twee = toTwee(story, 'twee3', { diagnostics });
        if (diagnostics.length === 0) expectReadsBack(story, twee, true);
        // Each warning is about a passage of the story.
        for (const d of diagnostics)
          expect(story.passages.some((p) => d.message.startsWith(`Passage ${JSON.stringify(p.name)}`))).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it('and passages without a warning read back the same when only they are written', () => {
    fc.assert(
      fc.property(anyStory, (inputs) => {
        const story = storyOf(inputs);
        for (const p of story.passages) {
          const single = storyOf([{ name: p.name, tags: p.tags, text: p.text, metadata: p.metadata }]);
          const diagnostics: Diagnostic[] = [];
          const twee = toTwee(single, 'twee3', { diagnostics });
          if (diagnostics.length === 0) expectReadsBack(single, twee, true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('Twee 1 output reads back as the same story where Twee 1 can hold it', () => {
  const twee1Writable = (s: string): boolean => !/[[\]{}\\]/.test(s);

  it('without metadata, and with no warning', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          passageInput(
            writableName.filter(twee1Writable),
            writableTag.filter(twee1Writable),
            writableText,
            fc.constant(undefined),
          ),
          {
            selector: (p) => p.name,
            maxLength: 5,
          },
        ),
        (inputs) => {
          const story = storyOf(inputs);
          const diagnostics: Diagnostic[] = [];
          const twee = toTwee(story, 'twee1', { diagnostics });
          expect(diagnostics).toEqual([]);
          expectReadsBack(story, twee, false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('warns once that metadata is left out', () => {
    const story = storyOf([{ name: 'A', tags: [], text: 'x', metadata: { position: '1,1' } }]);
    const diagnostics: Diagnostic[] = [];
    toTwee(story, 'twee1', { diagnostics });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Twee 1 has no passage metadata, so the metadata (such as "position") of 1 passage is left out.',
    ]);
  });

  it('for every story it writes without a warning', () => {
    fc.assert(
      fc.property(anyStory, (inputs) => {
        const story = storyOf(inputs.map((p) => ({ ...p, metadata: undefined })));
        const diagnostics: Diagnostic[] = [];
        const twee = toTwee(story, 'twee1', { diagnostics });
        if (diagnostics.length === 0) expectReadsBack(story, twee, false);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('the reader does not depend on how the source is laid out', () => {
  /** Twee source for writable passages, written by the writer. */
  const sources = writableStory.map((inputs) =>
    storyOf(inputs).passages.map((p) => toTwee(storyOf([{ ...p, metadata: p.metadata }]), 'twee3')),
  );

  async function compiled(files: readonly string[]): Promise<unknown> {
    const result = await compile({
      sources: files.map((content, i) => ({ filename: `f${i}.tw`, content })),
      outputMode: 'json',
      noRemote: true,
    });
    return result.story.passages.map((p) => comparable(p, true));
  }

  it('gives the same passages for one file, or the same text split into files at any headers', async () => {
    await fc.assert(
      fc.asyncProperty(sources, fc.array(fc.boolean(), { maxLength: 5 }), async (chunks, cuts) => {
        // A new file starts at each chunk with a cut before it; the others go on the file before.
        const files = chunks.reduce<string[]>(
          (out, chunk, i) =>
            i === 0 || cuts[i] === true ? [...out, chunk] : [...out.slice(0, -1), `${out.at(-1) ?? ''}${chunk}`],
          [],
        );
        expect(await compiled(files)).toEqual(await compiled([chunks.join('')]));
      }),
      { numRuns: 200 },
    );
  });

  it('gives the same passages for LF, CRLF and CR line endings, and with a BOM in front of each file', async () => {
    await fc.assert(
      fc.asyncProperty(sources, fc.constantFrom('\n', '\r\n', '\r'), fc.boolean(), async (chunks, eol, bom) => {
        const changed = chunks.map((chunk) => (bom ? '\ufeff' : '') + chunk.replace(/\n/g, eol));
        expect(await compiled(changed)).toEqual(await compiled(chunks));
        // Concatenated files keep their BOMs in front of their first headers.
        expect(await compiled([changed.join('')])).toEqual(await compiled(chunks));
      }),
      { numRuns: 200 },
    );
  });
});
