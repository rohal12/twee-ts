import { describe, it, expect } from 'vitest';
import {
  createStory,
  storyHas,
  storyGet,
  storyAdd,
  storyPrepend,
  marshalStoryData,
  decodeStoryData,
  unmarshalStorySettings,
  StoryBuilder,
} from '../src/story.js';
import type { Diagnostic, Passage } from '../src/types.js';
import { createIFID } from '../src/ifid.js';

function mkPassage(name: string, text = '', tags: string[] = []): Passage {
  return { name, tags, text };
}

describe('Story', () => {
  it('creates an empty story', () => {
    const story = createStory();
    expect(story.passages).toHaveLength(0);
    expect(story.name).toBe('');
    expect(story.ifid).toBe('');
    expect(story.twine2.zoom).toBe(1);
  });

  it('adds passages', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('Test', 'Content'), diag);
    expect(story.passages).toHaveLength(1);
    expect(storyHas(story, 'Test')).toBe(true);
    expect(storyGet(story, 'Test')?.text).toBe('Content');
  });

  it('warns on duplicate passages', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('Test', 'First'), diag);
    storyAdd(story, mkPassage('Test', 'Second'), diag);
    expect(story.passages).toHaveLength(1);
    expect(storyGet(story, 'Test')?.text).toBe('Second');
    expect(diag.some((d) => d.message.includes('duplicate'))).toBe(true);
  });

  it('processes StoryTitle', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('StoryTitle', '  My Story  '), diag);
    expect(story.name).toBe('My Story');
    expect(storyGet(story, 'StoryTitle')?.text).toBe('My Story');
  });

  it('processes StoryData', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(
      story,
      mkPassage(
        'StoryData',
        JSON.stringify({
          ifid: 'd674c58c-defa-4f70-b7a2-27742230c0fc',
          format: 'SugarCube',
          'format-version': '2.37.3',
          start: 'Begin',
        }),
      ),
      diag,
    );
    expect(story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(story.twine2.format).toBe('SugarCube');
    expect(story.twine2.formatVersion).toBe('2.37.3');
    expect(story.twine2.start).toBe('Begin');
  });

  it('stores a wrapped StoryData IFID as the bare UUID and rewrites the passage', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(
      story,
      mkPassage('StoryData', JSON.stringify({ ifid: 'uuid://d674c58c-defa-4f70-b7a2-27742230c0fc//' })),
      diag,
    );
    expect(diag).toEqual([]);
    expect(story.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(JSON.parse(storyGet(story, 'StoryData')!.text)).toEqual({ ifid: 'D674C58C-DEFA-4F70-B7A2-27742230C0FC' });
  });

  it('reports an invalid wrapped StoryData IFID as written', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(
      story,
      mkPassage('StoryData', JSON.stringify({ ifid: 'UUID://D674C58C-DEFA-0F70-B7A2-27742230C0FC//' })),
      diag,
    );
    expect(diag.map((d) => d.message)).toEqual(["Cannot validate IFID; invalid version '0' at position 15."]);
  });

  it('lookups work after storyPrepend', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('A', 'alpha'), diag);
    storyAdd(story, mkPassage('B', 'beta'), diag);
    storyPrepend(story, mkPassage('Z', 'zulu'), diag);
    expect(story.passages).toHaveLength(3);
    expect(storyHas(story, 'Z')).toBe(true);
    expect(storyHas(story, 'A')).toBe(true);
    expect(storyHas(story, 'B')).toBe(true);
    expect(storyGet(story, 'Z')?.text).toBe('zulu');
    expect(storyGet(story, 'A')?.text).toBe('alpha');
    expect(storyGet(story, 'B')?.text).toBe('beta');
    expect(story.passages[0]!.name).toBe('Z');
  });

  it('storyPrepend replaces existing passage in place', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('A', 'first'), diag);
    storyAdd(story, mkPassage('B', 'second'), diag);
    storyPrepend(story, mkPassage('A', 'replaced'), diag);
    expect(story.passages).toHaveLength(2);
    expect(storyGet(story, 'A')?.text).toBe('replaced');
    expect(diag.some((d) => d.message.includes('duplicate'))).toBe(true);
  });

  it('warns on StoryIncludes', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('StoryIncludes', 'file1.tw\nfile2.tw'), diag);
    expect(diag.some((d) => d.message.includes('StoryIncludes'))).toBe(true);
  });
});

describe('marshalStoryData', () => {
  it('roundtrips through marshal/unmarshal', () => {
    const story = createStory();
    story.ifid = createIFID('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    story.twine2.format = 'SugarCube';
    story.twine2.formatVersion = '2.37.3';
    story.twine2.start = 'Begin';

    const decoded = decodeStoryData(marshalStoryData(story));
    expect(decoded).toEqual({ ok: true, ifid: story.ifid, twine2: story.twine2, issues: [] });
  });
});

describe('unmarshalStorySettings', () => {
  it('parses key:value pairs', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    unmarshalStorySettings(story, 'obfuscate:rot13\njquery:on', diag);
    expect(story.twine1.settings.get('obfuscate')).toBe('rot13');
    expect(story.twine1.settings.get('jquery')).toBe('on');
  });

  it('warns about obsolete ifid and zoom entries', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    unmarshalStorySettings(story, 'ifid:D674C58C-DEFA-4F70-B7A2-27742230C0FC\nzoom:2', diag);
    expect(diag.some((d) => d.message.includes('obsolete'))).toBe(true);
    expect(story.legacyIFID).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });

  it('stores a wrapped legacy ifid entry as the bare UUID', () => {
    const story = createStory();
    unmarshalStorySettings(story, 'ifid:UUID://D674C58C-DEFA-4F70-B7A2-27742230C0FC//', []);
    expect(story.legacyIFID).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
  });
});

describe('a later StoryData passage', () => {
  const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
  const FULL = JSON.stringify({
    ifid: IFID,
    format: 'SugarCube',
    'format-version': '2.37.3',
    options: ['debug'],
    start: 'Old',
    tags: 'draft',
    'tag-colors': { old: 'red' },
    zoom: 0.6,
  });

  it('replaces the story metadata of an earlier one instead of merging into it', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('StoryData', FULL), diag);
    storyAdd(story, mkPassage('StoryData', JSON.stringify({ ifid: IFID })), diag);

    expect(diag.map((d) => d.message)).toEqual(['Replacing existing passage "StoryData" with duplicate.']);
    expect(story.ifid).toBe(IFID);
    expect(story.twine2).toEqual({
      format: '',
      formatVersion: '',
      options: new Map(),
      start: '',
      tags: '',
      tagColors: new Map(),
      zoom: 1,
    });
    expect(JSON.parse(storyGet(story, 'StoryData')!.text)).toEqual({ ifid: IFID });
  });

  it('clears the IFID when it has none, so the StorySettings IFID can stand in', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('StorySettings', `ifid:${IFID}`), diag);
    storyAdd(story, mkPassage('StoryData', JSON.stringify({ ifid: '0B3F1A2C-1D4E-4F5A-8B6C-7D8E9F0A1B2C' })), diag);
    storyAdd(story, mkPassage('StoryData', JSON.stringify({ format: 'Harlowe' })), diag);

    expect(story.ifid).toBe('');
    expect(story.legacyIFID).toBe(IFID);
    expect(story.twine2.format).toBe('Harlowe');
  });

  it('lets a later StoryData that is not valid JSON win, with the defaults and an error (T-02)', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, { ...mkPassage('StoryData', FULL), source: { file: 'a.tw', line: 1 } }, diag);
    storyAdd(story, { ...mkPassage('StoryData', '{ not json'), source: { file: 'b.tw', line: 4 } }, diag);

    expect(story.ifid).toBe('');
    expect(story.twine2.start).toBe('');
    expect(story.twine2.format).toBe('');
    expect(story.twine2.options).toEqual(new Map());
    expect(storyGet(story, 'StoryData')?.text).toBe('{ not json');
    expect(diag.map((d) => [d.level, d.file, d.line])).toEqual([
      ['error', 'b.tw', 4],
      ['warning', 'b.tw', 4],
    ]);
    expect(diag[0]?.message).toMatch(/^Cannot unmarshal "StoryData" compiler special passage; /);
  });
});

describe('StoryBuilder changes its story only through its methods (#171)', () => {
  function built(...names: string[]): { builder: StoryBuilder; diag: Diagnostic[] } {
    const builder = new StoryBuilder();
    const diag: Diagnostic[] = [];
    for (const name of names) builder.add(mkPassage(name, name.toLowerCase()), diag);
    return { builder, diag };
  }

  function contents(builder: StoryBuilder): string[] {
    return builder.build().passages.map((p) => `${p.name}=${p.text}`);
  }

  it('hands out frozen copies that cannot change the builder', () => {
    const { builder } = built('A', 'B');
    const story = builder.build();
    expect(Object.isFrozen(story.passages)).toBe(true);
    expect(Object.isFrozen(story.passages[0])).toBe(true);
    expect(Object.isFrozen(story.passages[0]?.tags)).toBe(true);
    expect(() => {
      Reflect.apply(Array.prototype.push, story.passages, [mkPassage('C')]);
    }).toThrow(TypeError);
    expect(Reflect.set(story.passages[0] ?? {}, 'name', 'Z')).toBe(false);
    expect(builder.has('A')).toBe(true);
    expect(builder.has('Z')).toBe(false);
    expect(builder).not.toHaveProperty('story');
    expect(builder.passages).toEqual(story.passages);
  });

  it('is not changed by a later change to an added passage object', () => {
    const builder = new StoryBuilder();
    const passage = { ...mkPassage('A', 'a', ['t']), metadata: { position: '1,1' } };
    builder.add(passage, []);
    passage.name = 'Z';
    passage.tags.push('u');
    passage.metadata.position = '9,9';
    expect(builder.get('A')).toEqual({ name: 'A', tags: ['t'], text: 'a', metadata: { position: '1,1' } });
    expect(builder.get('Z')).toBeUndefined();
  });

  it('is not changed by a later build: each build is a snapshot', () => {
    const { builder, diag } = built('A');
    const first = builder.build();
    builder.add(mkPassage('B', 'b'), diag);
    expect(first.passages.map((p) => p.name)).toEqual(['A']);
    expect(contents(builder)).toEqual(['A=a', 'B=b']);
  });

  it('forgets a removed passage and adds it again at the end without overwriting another', () => {
    const { builder, diag } = built('A', 'B', 'C');
    expect(builder.remove('A')).toBe(true);
    expect(builder.remove('A')).toBe(false);
    expect(builder.has('A')).toBe(false);
    builder.add(mkPassage('A', 'A again'), diag);
    expect(contents(builder)).toEqual(['B=b', 'C=c', 'A=A again']);
    expect(diag).toEqual([]);
  });

  it('renames a passage in place, and finds it by its new name only', () => {
    const { builder, diag } = built('A', 'B');
    expect(builder.rename('A', 'Z', diag)).toBe(true);
    expect(builder.has('Z')).toBe(true);
    expect(builder.has('A')).toBe(false);
    builder.add(mkPassage('A', 'A again'), diag);
    expect(contents(builder)).toEqual(['Z=a', 'B=b', 'A=A again']);
    expect(diag).toEqual([]);
  });

  it('replaces the passage that has the new name, with a warning, so no name is held twice (#171 follow-up)', () => {
    const { builder, diag } = built('A', 'B', 'C');
    expect(builder.rename('C', 'A', diag)).toBe(true);
    expect(contents(builder)).toEqual(['B=b', 'A=c']);
    builder.add(mkPassage('A', 'replacement'), diag);
    expect(contents(builder)).toEqual(['B=b', 'A=replacement']);
    expect(diag.map((d) => d.message)).toEqual([
      'Replacing existing passage "A" with duplicate.',
      'Replacing existing passage "A" with duplicate.',
    ]);
  });

  it('keeps the place of a renamed passage when an earlier passage had the new name', () => {
    const { builder, diag } = built('A', 'B', 'C', 'D');
    builder.rename('C', 'A', diag);
    expect(contents(builder)).toEqual(['B=b', 'A=c', 'D=d']);
  });

  it('does nothing for a missing name, and nothing but succeed for a rename to the same name', () => {
    const { builder, diag } = built('A');
    expect(builder.rename('Missing', 'X', diag)).toBe(false);
    expect(builder.rename('A', 'A', diag)).toBe(true);
    expect(contents(builder)).toEqual(['A=a']);
    expect(diag).toEqual([]);
  });

  it('moves the metadata with the special passage names', () => {
    const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
    const builder = new StoryBuilder();
    const diag: Diagnostic[] = [];
    builder.add(mkPassage('Notes', `{"ifid":"${IFID}","format":"Harlowe"}`), diag);
    builder.add(mkPassage('Title', 'My Story'), diag);
    builder.rename('Notes', 'StoryData', diag);
    builder.rename('Title', 'StoryTitle', diag);
    expect(builder.build()).toMatchObject({ ifid: IFID, name: 'My Story', twine2: { format: 'Harlowe' } });
    builder.rename('StoryData', 'Notes', diag);
    expect(builder.remove('StoryTitle')).toBe(true);
    expect(builder.build()).toMatchObject({ ifid: '', name: '', twine2: { format: '' } });
    expect(diag).toEqual([]);
  });
});

describe('storyHas and storyAdd after direct changes to story.passages', () => {
  it('follow a reassigned or resized passage array', () => {
    const story = createStory();
    const diag: Diagnostic[] = [];
    storyAdd(story, mkPassage('A', 'a'), diag);
    storyAdd(story, mkPassage('B', 'b'), diag);
    story.passages = story.passages.filter((p) => p.name !== 'A');
    expect(storyHas(story, 'A')).toBe(false);
    story.passages.push(mkPassage('C', 'c'));
    expect(storyHas(story, 'C')).toBe(true);
    storyAdd(story, mkPassage('A', 'A again'), diag);
    expect(story.passages.map((p) => `${p.name}=${p.text}`)).toEqual(['B=b', 'C=c', 'A=A again']);
    expect(diag).toEqual([]);
  });
});
