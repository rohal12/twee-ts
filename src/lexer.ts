/**
 * Twee 3 state-machine lexer implemented as a synchronous generator.
 * Ported from tweelexer.go — Go channels become `yield`.
 */
import type { LexerItem } from './types.js';
import { ItemType } from './types.js';

const EOF = -1;
const HEADER_DELIM = '::';
const NEWLINE_HEADER_DELIM = '\n::';

type StateFn = ((ctx: LexerContext) => StateFn | null) | null;

class LexerContext {
  readonly input: string;
  line = 1;
  start = 0;
  pos = 0;
  private items: LexerItem[] = [];

  constructor(input: string) {
    this.input = input;
  }

  next(): number {
    if (this.pos >= this.input.length) return EOF;
    const ch = this.input.charCodeAt(this.pos);
    this.pos++;
    if (ch === 0x0a) this.line++;
    return ch;
  }

  peek(): number {
    if (this.pos >= this.input.length) return EOF;
    return this.input.charCodeAt(this.pos);
  }

  backup(): void {
    if (this.pos > this.start) {
      this.pos--;
      if (this.input.charCodeAt(this.pos) === 0x0a) this.line--;
    } else {
      throw new Error('backup would leave pos < start');
    }
  }

  // Line-counting invariant: next() increments this.line for each newline during
  // character-by-character scanning. However, Content items are produced by jumping
  // this.pos directly (e.g. via indexOf) without calling next(), so those newlines
  // haven't been counted yet. emit() re-counts newlines in [start, pos) for Content
  // items to compensate. This is safe because this.start is reset to this.pos after
  // every emit(), so no range is ever counted twice.
  emit(type: ItemType): void {
    const val = this.input.slice(this.start, this.pos);
    this.items.push({ type, line: this.line, pos: this.start, val });
    if (type === ItemType.Content) {
      for (let i = this.start; i < this.pos; i++) {
        if (this.input.charCodeAt(i) === 0x0a) this.line++;
      }
    }
    this.start = this.pos;
  }

  ignore(): void {
    for (let i = this.start; i < this.pos; i++) {
      if (this.input.charCodeAt(i) === 0x0a) this.line++;
    }
    this.start = this.pos;
  }

  acceptRun(valid: string): void {
    let ch: number;
    for (ch = this.next(); ch !== EOF && valid.includes(String.fromCharCode(ch)); ch = this.next()) {
      // consume
    }
    if (ch !== EOF) this.backup();
  }

  errorf(message: string): null {
    this.items.push({
      type: ItemType.Error,
      line: this.line,
      pos: this.start,
      val: message,
    });
    return null;
  }

  /** Drain all pending items and return them. */
  drainItems(): LexerItem[] {
    const result = this.items;
    this.items = [];
    return result;
  }
}

function acceptQuoted(ctx: LexerContext, quote: number): string | null {
  for (;;) {
    const ch = ctx.next();
    switch (ch) {
      case 0x5c: {
        // backslash
        const r = ctx.next();
        if (r !== 0x0a && r !== EOF) break;
        // fall through
      }
      // falls through
      case 0x0a:
      case EOF:
        return 'unterminated quoted string';
      default:
        if (ch === quote) return null;
        break;
    }
  }
}

// --- State functions ---

function lexProlog(ctx: LexerContext): StateFn {
  if (ctx.input.startsWith(HEADER_DELIM, ctx.pos)) {
    return lexHeaderDelim;
  }
  const i = ctx.input.indexOf(NEWLINE_HEADER_DELIM, ctx.pos);
  if (i > -1) {
    ctx.pos = i + 1; // skip to the newline, then past it
    ctx.ignore();
    return lexHeaderDelim;
  }
  ctx.emit(ItemType.EOF);
  return null;
}

function lexContent(ctx: LexerContext): StateFn {
  if (ctx.input.startsWith(HEADER_DELIM, ctx.pos)) {
    return lexHeaderDelim;
  }
  const i = ctx.input.indexOf(NEWLINE_HEADER_DELIM, ctx.pos);
  if (i > -1) {
    ctx.pos = i + 1;
    ctx.emit(ItemType.Content);
    return lexHeaderDelim;
  }
  ctx.pos = ctx.input.length;
  if (ctx.pos > ctx.start) {
    ctx.emit(ItemType.Content);
  }
  ctx.emit(ItemType.EOF);
  return null;
}

function lexHeaderDelim(ctx: LexerContext): StateFn {
  ctx.pos += HEADER_DELIM.length;
  ctx.emit(ItemType.Header);
  return lexName;
}

function lexName(ctx: LexerContext): StateFn {
  let r: number;
  outer: for (;;) {
    r = ctx.next();
    switch (r) {
      case 0x5c: {
        // backslash
        const next = ctx.next();
        if (next !== 0x0a && next !== EOF) break;
        // fall through to terminators
        r = next;
      }
      // falls through
      case 0x5b: // [
      case 0x5d: // ]
      case 0x7b: // {
      case 0x7d: // }
      case 0x0a: // \n
      case EOF:
        if (r !== EOF) ctx.backup();
        break outer;
    }
  }
  // Always emit a name item, even if empty.
  ctx.emit(ItemType.Name);

  switch (r) {
    case 0x5b:
      return lexTags; // [
    case 0x5d:
      return ctx.errorf(`unexpected right square bracket ']'`);
    case 0x7b:
      return lexMetadata; // {
    case 0x7d:
      return ctx.errorf(`unexpected right curly brace '}'`);
    case 0x0a: // newline
      ctx.pos++;
      ctx.ignore();
      return lexContent;
  }
  ctx.emit(ItemType.EOF);
  return null;
}

function lexNextOptionalBlock(ctx: LexerContext): StateFn {
  // Consume whitespace.
  ctx.acceptRun(' \t');
  ctx.ignore();

  const r = ctx.peek();
  switch (r) {
    case 0x5b:
      return lexTags; // [
    case 0x5d:
      return ctx.errorf(`unexpected right square bracket ']'`);
    case 0x7b:
      return lexMetadata; // {
    case 0x7d:
      return ctx.errorf(`unexpected right curly brace '}'`);
    case 0x0a: // newline
      ctx.pos++;
      ctx.ignore();
      return lexContent;
    case EOF:
      ctx.emit(ItemType.EOF);
      return null;
  }
  return ctx.errorf(`illegal character '${String.fromCharCode(r)}' amid the optional blocks`);
}

function lexTags(ctx: LexerContext): StateFn {
  // Consume the left delimiter '['.
  ctx.pos++;

  for (;;) {
    const r = ctx.next();
    switch (r) {
      case 0x5c: {
        // backslash
        const next = ctx.next();
        if (next !== 0x0a && next !== EOF) break;
        // fall through
      }
      // falls through
      case 0x0a:
      case EOF:
        if (r === 0x0a) ctx.backup();
        return ctx.errorf('unterminated tag block');
      case 0x5d: // ]
        if (ctx.pos > ctx.start) ctx.emit(ItemType.Tags);
        return lexNextOptionalBlock;
      case 0x5b: // [
        return ctx.errorf(`unexpected left square bracket '['`);
      case 0x7b: // {
        return ctx.errorf(`unexpected left curly brace '{'`);
      case 0x7d: // }
        return ctx.errorf(`unexpected right curly brace '}'`);
    }
  }
}

function lexMetadata(ctx: LexerContext): StateFn {
  // Consume the left delimiter '{'.
  ctx.pos++;

  let depth = 1;
  for (;;) {
    const r = ctx.next();
    switch (r) {
      case 0x22: {
        // double quote
        const err = acceptQuoted(ctx, 0x22);
        if (err) return ctx.errorf(err);
        break;
      }
      case 0x0a: // newline
        ctx.backup();
      // falls through
      case EOF:
        return ctx.errorf('unterminated metadata block');
      case 0x7b: // {
        depth++;
        break;
      case 0x7d: // }
        depth--;
        if (depth === 0) {
          if (ctx.pos > ctx.start) ctx.emit(ItemType.Metadata);
          return lexNextOptionalBlock;
        }
        break;
    }
  }
}

/**
 * Twee 3 lexer — yields LexerItem tokens from Twee source text.
 *
 * In the Go reference, this uses goroutines and channels.
 * Here we use a synchronous generator that accumulates items per state step.
 */
export function* tweeLexer(input: string): Generator<LexerItem, void, undefined> {
  const ctx = new LexerContext(input);
  let state: StateFn = lexProlog;
  while (state !== null) {
    state = state(ctx);
    const items = ctx.drainItems();
    for (const item of items) {
      yield item;
    }
  }
  // Drain any remaining items.
  const remaining = ctx.drainItems();
  for (const item of remaining) {
    yield item;
  }
}

/** Convenience class wrapper for the lexer generator. */
export class TweeLexer {
  private gen: Generator<LexerItem, void, undefined>;

  constructor(input: string) {
    this.gen = tweeLexer(input);
  }

  nextItem(): { item: LexerItem; done: boolean } {
    const result = this.gen.next();
    if (result.done) {
      return { item: { type: ItemType.EOF, line: 0, pos: 0, val: '' }, done: true };
    }
    return { item: result.value, done: false };
  }

  *[Symbol.iterator](): Generator<LexerItem, void, undefined> {
    yield* this.gen;
  }
}
