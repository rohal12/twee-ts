import { describe, it, expect } from 'vitest';
import {
  countWords,
  decodePassageMetadata,
  metadataForOutput,
  passageToPassagedata,
  passageToTiddler,
  passageToTwee,
} from '../src/passage.js';
import type { Passage, WordCountMethod } from '../src/types.js';

const mk = (over: Partial<Passage> = {}): Passage => ({ name: 'A', tags: [], text: 'body', ...over });

describe('decodePassageMetadata', () => {
  it('keeps string values, reads null as empty and reports the values it leaves out', () => {
    expect(decodePassageMetadata('{"position":"1,2","size":null,"x":3,"y":"z"}')).toEqual({
      ok: true,
      metadata: { position: '1,2', size: '', y: 'z' },
      issues: [{ kind: 'type', path: ['x'], message: '$.x must be a string, not a number (3)' }],
    });
  });

  it('rejects the whole block when position or size has the wrong type, as Tweego does', () => {
    expect(decodePassageMetadata('{"position":[1,2],"size":"3,4"}')).toEqual({
      ok: false,
      reason: '$.position must be a string, not an array',
    });
  });

  it('rejects JSON that is not an object', () => {
    for (const json of ['[1,2]', 'null', '"text"']) {
      expect(decodePassageMetadata(json)).toEqual({ ok: false, reason: 'expected a JSON object' });
    }
  });

  it('rejects invalid JSON with the position of the error', () => {
    expect(decodePassageMetadata('{nope')).toEqual({
      ok: false,
      reason: 'unexpected character "n"; expected a string key or "}" at line 1, column 2',
    });
  });

  it('reads position and size keys regardless of letter case, the last one winning, as Go does', () => {
    const decoded = decodePassageMetadata('{"POSITION":"1,1","Position":"2,2","Size":"3,3"}');
    expect(decoded).toEqual({
      ok: true,
      metadata: { position: '2,2', size: '3,3' },
      issues: [
        expect.objectContaining({ kind: 'case-variant-key', path: ['POSITION'] }),
        expect.objectContaining({ kind: 'case-variant-key', path: ['Position'] }),
        expect.objectContaining({ kind: 'duplicate-key', path: ['Position'] }),
        expect.objectContaining({ kind: 'case-variant-key', path: ['Size'] }),
      ],
    });
  });

  it('keeps __proto__ and constructor as own keys (#241)', () => {
    const decoded = decodePassageMetadata('{"__proto__":"kept","constructor":"control","position":"1,1"}');
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Object.getPrototypeOf(decoded.metadata)).toBe(Object.prototype);
    expect(Object.keys(decoded.metadata)).toEqual(['__proto__', 'constructor', 'position']);
    expect(Object.getOwnPropertyDescriptor(decoded.metadata, '__proto__')?.value).toBe('kept');
    expect(JSON.stringify(metadataForOutput(decoded.metadata))).toBe(
      '{"__proto__":"kept","constructor":"control","position":"1,1"}',
    );
  });

  it('round-trips with metadataForOutput, which leaves out empty values', () => {
    const written = JSON.stringify(metadataForOutput({ position: '5,5', size: '' }));
    expect(decodePassageMetadata(written)).toEqual({ ok: true, metadata: { position: '5,5' }, issues: [] });
    expect(metadataForOutput({ size: '' })).toBeUndefined();
    expect(metadataForOutput(undefined)).toBeUndefined();
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
