import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, lint, parseTwee, passageOmission, startPassageDiagnostics, StoryBuilder } from '../src/index.js';
import type { Diagnostic, PassageOmission, ReadonlyStory } from '../src/index.js';

const metadata = ':: StoryTitle\nExample\n\n:: StoryData\n{"ifid":"7E95B777-0E72-4603-AA57-049388D05756"}\n\n';

function build(content: string): ReadonlyStory {
  const builder = new StoryBuilder();
  const diagnostics: Diagnostic[] = [];
  for (const passage of parseTwee(content).passages) builder.add(passage, diagnostics);
  return builder.build();
}

const cases: readonly {
  readonly label: string;
  readonly content: string;
  readonly start: string;
  readonly omission: PassageOmission | 'absent' | undefined;
}[] = [
  { label: 'implicit Start', content: ':: Start\nHello', start: 'Start', omission: undefined },
  { label: 'absent implicit Start', content: ':: Room\nHello', start: 'Start', omission: 'absent' },
  {
    label: 'explicit entry',
    content: ':: StoryData\n{"start":"Room"}\n:: Room\nHello',
    start: 'Room',
    omission: undefined,
  },
  {
    label: 'absent explicit entry',
    content: ':: StoryData\n{"start":"Missing"}\n:: Start\nHello',
    start: 'Missing',
    omission: 'absent',
  },
  {
    label: 'null member retains an earlier start in the same object',
    content: ':: StoryData\n{"start":"Missing","start":null}\n:: Start\nHello',
    start: 'Missing',
    omission: 'absent',
  },
  ...(['script', 'stylesheet', 'Twine.private'] as const).flatMap((tag) => [
    {
      label: `implicit ${tag} entry`,
      content: `:: Start [${tag}]\nvoid 0;`,
      start: 'Start',
      omission: { kind: 'tag', tag } as const,
    },
    {
      label: `explicit ${tag} entry`,
      content: `:: StoryData\n{"start":"Hidden"}\n:: Hidden [${tag}]\nvoid 0;`,
      start: 'Hidden',
      omission: { kind: 'tag', tag } as const,
    },
  ]),
  ...(['StoryTitle', 'StoryData'] as const).map((name) => ({
    label: `special ${name} entry`,
    content: `:: StoryData\n{"start":"${name}"}`,
    start: name,
    omission: { kind: 'special-name', name } as const,
  })),
  {
    label: 'empty settings',
    content: ':: StoryData\n{"start":"StorySettings"}\n:: StorySettings\n',
    start: 'StorySettings',
    omission: { kind: 'empty-story-settings' },
  },
  {
    label: 'nonempty settings',
    content: ':: StoryData\n{"start":"StorySettings"}\n:: StorySettings\njquery:on',
    start: 'StorySettings',
    omission: undefined,
  },
  {
    label: 'replaced settings',
    content: ':: StoryData\n{"start":"StorySettings"}\n:: StorySettings\njquery:on\n:: StorySettings\n',
    start: 'StorySettings',
    omission: { kind: 'empty-story-settings' },
  },
  {
    label: 'replacement keeps passage',
    content: ':: Start [script]\nvoid 0;\n:: Start\nHello',
    start: 'Start',
    omission: undefined,
  },
  {
    label: 'replacement omits passage',
    content: ':: Start\nHello\n:: Start [Twine.private]\nSecret',
    start: 'Start',
    omission: { kind: 'tag', tag: 'Twine.private' },
  },
  ...['{}', '{"start":null}', '{"start":""}', 'null'].map((data) => ({
    label: `replaced metadata ${data}`,
    content: `:: StoryData\n{"start":"Missing"}\n:: StoryData\n${data}\n:: Start\nHello`,
    start: 'Start',
    omission: undefined,
  })),
];

describe('public synchronous entry validation (#528)', () => {
  it.each(cases)('$label shares compiler and lint diagnostics', async ({ content, start, omission }) => {
    const text = metadata + content;
    const story = build(text);
    const diagnostics = startPassageDiagnostics(story);
    expect(diagnostics).toHaveLength(omission === undefined ? 0 : 1);
    expect(diagnostics.every((diagnostic) => diagnostic.level === 'error')).toBe(true);
    const message = expect.stringContaining(`Starting passage "${start}"`);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(omission === undefined ? [] : [message]);
    const passage = story.passages.find((p) => p.name === start);
    expect(passage === undefined ? 'absent' : passageOmission(story, passage, 'twine2')).toEqual(omission);
    const sources = [{ filename: 'story.tw', content: text }];
    const compiled = await compile({
      sources,
      formatId: 'test-format-1',
      formatPaths: [join(__dirname, 'fixtures/storyformats')],
      useTweegoPath: false,
      noRemote: true,
    });
    const linted = await lint({ sources });
    const entryOnly = (items: readonly Diagnostic[]): readonly Diagnostic[] =>
      items.filter((d) => d.message.startsWith('Starting passage '));
    expect(entryOnly(compiled.diagnostics)).toEqual(diagnostics);
    expect(entryOnly(linted.diagnostics)).toEqual(diagnostics);
  });

  it.each(cases)('$label uses the selected Twine 1 output rules', ({ content, start, omission }) => {
    const story = build(metadata + content);
    const expected =
      omission === 'absent' || (omission?.kind === 'tag' && omission.tag === 'Twine.private') ? omission : undefined;
    const diagnostics = startPassageDiagnostics(story, undefined, 'twine1');
    expect(diagnostics).toHaveLength(expected === undefined ? 0 : 1);
    const passage = story.passages.find((p) => p.name === start);
    expect(passage === undefined ? 'absent' : passageOmission(story, passage, 'twine1')).toEqual(expected);
  });

  it('accepts an override without changing the snapshot or its effective metadata', () => {
    const story = build(':: StoryData\n{"start":"Hidden"}\n:: Hidden [script]\nvoid 0;\n:: Begin\nHello');
    expect(startPassageDiagnostics(story)).toHaveLength(1);
    expect(startPassageDiagnostics(story, 'Begin')).toEqual([]);
    expect(startPassageDiagnostics(story, 'Missing')).toEqual([
      { level: 'error', message: 'Starting passage "Missing" not found.' },
    ]);
    expect(startPassageDiagnostics(story, '')).toEqual([{ level: 'error', message: 'Starting passage "" not found.' }]);
    expect(story.twine2.start).toBe('Hidden');
    expect(startPassageDiagnostics(story)).toHaveLength(1);
  });

  it('reports an empty story synchronously', () => {
    expect(startPassageDiagnostics(new StoryBuilder().build())).toEqual([
      { level: 'error', message: 'Starting passage "Start" not found.' },
    ]);
  });
});
