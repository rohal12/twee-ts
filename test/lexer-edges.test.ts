import { describe, it, expect } from 'vitest';
import { tweeLexer, TweeLexer } from '../src/lexer.js';
import { ItemType } from '../src/types.js';

const items = (src: string) => [...tweeLexer(src)];
const types = (src: string) => items(src).map((i) => i.type);
const lastType = (src: string) => items(src).at(-1)?.type;

describe('tweeLexer: input ending inside a header', () => {
  it('ends with EOF after a name with no newline', () => {
    expect(types(':: Name')).toEqual([ItemType.Header, ItemType.Name, ItemType.EOF]);
  });

  it('ends with EOF after a tags block with no newline', () => {
    expect(types(':: Name [a b]')).toEqual([ItemType.Header, ItemType.Name, ItemType.Tags, ItemType.EOF]);
  });

  it('ends with EOF after a metadata block with no newline', () => {
    expect(types(':: Name {"a":"b"}')).toEqual([ItemType.Header, ItemType.Name, ItemType.Metadata, ItemType.EOF]);
  });
});

describe('tweeLexer: malformed headers', () => {
  it('reports an illegal character between the optional blocks', () => {
    expect(lastType(':: Name [a] x\nbody')).toBe(ItemType.Error);
  });

  it('reports a stray right bracket or brace', () => {
    expect(lastType(':: Name [a] ]')).toBe(ItemType.Error);
    expect(lastType(':: Name [a] }')).toBe(ItemType.Error);
    expect(lastType(':: Name ]')).toBe(ItemType.Error);
    expect(lastType(':: Name }')).toBe(ItemType.Error);
  });

  it('reports unterminated tag and metadata blocks', () => {
    expect(lastType(':: Name [a\nbody')).toBe(ItemType.Error);
    expect(lastType(':: Name [a')).toBe(ItemType.Error);
    expect(lastType(':: Name {"a":\nbody')).toBe(ItemType.Error);
    expect(lastType(':: Name {"a":1')).toBe(ItemType.Error);
  });
});

describe('TweeLexer class', () => {
  it('reports done with an EOF item once the input is used up', () => {
    const lexer = new TweeLexer(':: A');
    expect(lexer.nextItem().item.type).toBe(ItemType.Header);
    expect(lexer.nextItem().item.type).toBe(ItemType.Name);
    expect(lexer.nextItem().item.type).toBe(ItemType.EOF);
    expect(lexer.nextItem()).toMatchObject({ done: true, item: { type: ItemType.EOF } });
  });

  it('is iterable', () => {
    const all = [...new TweeLexer(':: A\nx')];
    expect(all.map((i) => i.type)).toEqual([ItemType.Header, ItemType.Name, ItemType.Content, ItemType.EOF]);
  });
});
