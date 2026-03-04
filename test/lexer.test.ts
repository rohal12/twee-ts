import { describe, it, expect } from 'vitest';
import { tweeLexer, TweeLexer } from '../src/lexer.js';
import { ItemType } from '../src/types.js';

function collectItems(input: string) {
  return [...tweeLexer(input)];
}

describe('tweeLexer', () => {
  it('lexes a simple passage', () => {
    const items = collectItems(':: Start\nHello world!');
    expect(items).toHaveLength(4); // Header, Name, Content, EOF
    expect(items[0]!.type).toBe(ItemType.Header);
    expect(items[0]!.val).toBe('::');
    expect(items[1]!.type).toBe(ItemType.Name);
    expect(items[1]!.val).toBe(' Start');
    expect(items[2]!.type).toBe(ItemType.Content);
    expect(items[2]!.val).toBe('Hello world!');
    expect(items[3]!.type).toBe(ItemType.EOF);
  });

  it('lexes passage with tags', () => {
    const items = collectItems(':: Room [location hidden]\nYou are here.');
    expect(items[0]!.type).toBe(ItemType.Header);
    expect(items[1]!.type).toBe(ItemType.Name);
    expect(items[1]!.val).toBe(' Room ');
    expect(items[2]!.type).toBe(ItemType.Tags);
    expect(items[2]!.val).toBe('[location hidden]');
    expect(items[3]!.type).toBe(ItemType.Content);
    expect(items[4]!.type).toBe(ItemType.EOF);
  });

  it('lexes passage with metadata', () => {
    const items = collectItems(':: Room {"position":"100,100"}\nContent');
    expect(items[2]!.type).toBe(ItemType.Metadata);
    expect(items[2]!.val).toBe('{"position":"100,100"}');
  });

  it('lexes passage with tags and metadata', () => {
    const items = collectItems(':: Room [tag1] {"position":"100,100"}\nContent');
    expect(items[2]!.type).toBe(ItemType.Tags);
    expect(items[3]!.type).toBe(ItemType.Metadata);
  });

  it('lexes multiple passages', () => {
    const input = ':: First\nContent 1\n\n:: Second\nContent 2';
    const items = collectItems(input);
    const headers = items.filter((i) => i.type === ItemType.Header);
    expect(headers).toHaveLength(2);
    const names = items.filter((i) => i.type === ItemType.Name);
    expect(names).toHaveLength(2);
    expect(names[0]!.val).toBe(' First');
    expect(names[1]!.val).toBe(' Second');
  });

  it('handles prolog (text before first ::)', () => {
    const items = collectItems('Some prolog text\n:: Start\nContent');
    expect(items[0]!.type).toBe(ItemType.Header);
    expect(items[1]!.val).toBe(' Start');
  });

  it('handles empty input', () => {
    const items = collectItems('');
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe(ItemType.EOF);
  });

  it('handles input with no passages', () => {
    const items = collectItems('Just some text without any passages');
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe(ItemType.EOF);
  });

  it('handles passage with no content', () => {
    const items = collectItems(':: Empty\n:: Next\nContent');
    const names = items.filter((i) => i.type === ItemType.Name);
    expect(names).toHaveLength(2);
  });

  it('handles escaped characters in passage names', () => {
    const items = collectItems(':: Name\\[with\\]brackets\nContent');
    expect(items[1]!.type).toBe(ItemType.Name);
    expect(items[1]!.val).toBe(' Name\\[with\\]brackets');
  });

  it('reports error for unterminated tag block', () => {
    const items = collectItems(':: Test [unclosed\nContent');
    const errors = items.filter((i) => i.type === ItemType.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.val).toContain('unterminated tag block');
  });

  it('reports error for unterminated metadata block', () => {
    // Without a quoted string, the newline terminates the metadata block
    const items = collectItems(':: Test {no closing\nContent');
    const errors = items.filter((i) => i.type === ItemType.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.val).toContain('unterminated metadata block');
  });

  it('reports error for unterminated quoted string in metadata', () => {
    const items = collectItems(':: Test {"no closing\nContent');
    const errors = items.filter((i) => i.type === ItemType.Error);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.val).toContain('unterminated quoted string');
  });

  it('handles nested braces in metadata', () => {
    const items = collectItems(':: Test {"nested":{"a":"b"}}\nContent');
    expect(items[2]!.type).toBe(ItemType.Metadata);
    expect(items[2]!.val).toBe('{"nested":{"a":"b"}}');
  });

  it('handles quoted strings in metadata', () => {
    const items = collectItems(':: Test {"key":"value with \\\"escaped\\\""}\nContent');
    const meta = items.find((i) => i.type === ItemType.Metadata);
    expect(meta).toBeDefined();
  });
});

describe('TweeLexer class', () => {
  it('iterates via nextItem()', () => {
    const lexer = new TweeLexer(':: Start\nHello');
    const items: import('../src/types.js').LexerItem[] = [];
    for (;;) {
      const { item, done } = lexer.nextItem();
      items.push(item);
      if (done || item.type === ItemType.EOF) break;
    }
    expect(items.length).toBeGreaterThanOrEqual(4);
  });
});
