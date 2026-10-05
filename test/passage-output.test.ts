import { describe, it, expect } from 'vitest';
import {
  countWords,
  marshalMetadata,
  passageToPassagedata,
  passageToTiddler,
  passageToTwee,
  unmarshalMetadata,
} from '../src/passage.js';
import type { Passage, WordCountMethod } from '../src/types.js';

const mk = (over: Partial<Passage> = {}): Passage => ({ name: 'A', tags: [], text: 'body', ...over });

describe('unmarshalMetadata', () => {
  it('keeps string values and drops the rest', () => {
    expect(unmarshalMetadata('{"position":"1,2","size":3,"x":null}')).toEqual({ position: '1,2' });
  });

  it('returns no metadata for JSON that is not an object', () => {
    expect(unmarshalMetadata('[1,2]')).toEqual({});
    expect(unmarshalMetadata('null')).toEqual({});
    expect(unmarshalMetadata('"text"')).toEqual({});
  });

  it('throws on invalid JSON', () => {
    expect(() => unmarshalMetadata('{nope')).toThrow();
  });

  it('round-trips with marshalMetadata, which drops empty values', () => {
    expect(unmarshalMetadata(marshalMetadata({ position: '5,5', size: '' }))).toEqual({ position: '5,5' });
  });
});

describe('passageToPassagedata: layout positions', () => {
  const position = (pid: number) => /position="([^"]*)"/.exec(passageToPassagedata(mk(), pid))?.[1];

  it('lays passages out in rows of ten', () => {
    expect(position(1)).toBe('100,100');
    expect(position(10)).toBe('1225,100');
    expect(position(11)).toBe('100,225');
    expect(position(20)).toBe('1225,225');
  });

  it('uses the metadata position and size when set', () => {
    const html = passageToPassagedata(mk({ metadata: { position: '7,8', size: '200,300' } }), 1);
    expect(html).toContain('position="7,8"');
    expect(html).toContain('size="200,300"');
  });

  it('falls back to the default size when the metadata has only a position', () => {
    expect(passageToPassagedata(mk({ metadata: { position: '7,8' } }), 1)).toContain('size="100,100"');
  });

  it('adds the source file and line on request', () => {
    const html = passageToPassagedata(mk({ source: { file: 'a.tw', line: 4 } }), 1, { sourceInfo: true });
    expect(html).toContain('data-source-file="a.tw" data-source-line="4"');
    expect(passageToPassagedata(mk({ source: { file: 'a.tw', line: 4 } }), 1)).not.toContain('data-source');
  });
});

describe('passageToTiddler: layout positions', () => {
  const position = (p: Passage, pid: number) => /twine-position="([^"]*)"/.exec(passageToTiddler(p, pid))?.[1];

  it('lays tiddlers out in rows of ten', () => {
    expect(position(mk(), 1)).toBe('10,10');
    expect(position(mk(), 10)).toBe('1270,10');
    expect(position(mk(), 11)).toBe('10,150');
  });

  it('uses the metadata position when set', () => {
    expect(position(mk({ metadata: { position: '3,4' } }), 1)).toBe('3,4');
  });
});

describe('passageToTwee', () => {
  it('writes tags and metadata in twee3 mode', () => {
    expect(passageToTwee(mk({ tags: ['a', 'b'], metadata: { position: '1,2' } }), 'twee3')).toBe(
      ':: A [a b] {"position":"1,2"}\nbody\n\n\n',
    );
  });

  it('omits metadata, and writes an empty passage as a header only, in twee1 mode', () => {
    expect(passageToTwee(mk({ tags: ['a'], text: '', metadata: { position: '1,2' } }), 'twee1')).toBe(':: A [a]\n\n\n');
  });
});

describe('countWords', () => {
  it('rejects an unknown method', () => {
    expect(() => countWords(mk(), 'bogus' as unknown as WordCountMethod)).toThrow('Unhandled word count method');
  });

  it('counts an empty passage as no words in either method', () => {
    expect(countWords(mk({ text: '' }))).toBe(0);
    expect(countWords(mk({ text: '' }), 'whitespace')).toBe(0);
  });
});
