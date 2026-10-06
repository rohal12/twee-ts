/**
 * Checks at the HTML output boundary: story text that HTML cannot carry, and code that the script and style
 * escapers change.
 *
 * HTML carries any text except: U+0000 NULL, which the parser drops from text and turns into U+FFFD elsewhere; lone
 * surrogates, which UTF-8 cannot encode (they are written as U+FFFD); and a carriage return in script or style
 * text, which the parser turns into a line feed (in text and attribute values it is written as `&#13;`, which keeps
 * it). Tags are written space-separated, so a tag holding white space (as Twee splits tags) reads back as several
 * tags.
 */
import type { Diagnostic, ReadonlyPassage, ReadonlyStory } from './types.js';
import { javaScriptContexts, cssContexts } from './code-context.js';
import type { JavaScriptContext } from './code-context.js';
import { scriptEscapeSites, styleEscapeSites } from './escape.js';
import type { EscapeSite } from './escape.js';
import { splitTweeFields } from './twee-syntax.js';

/** Matches a code point HTML cannot carry: U+0000 or a lone surrogate. */
const UNREPRESENTABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** An error when `text` (named `what` in the message) holds a code point HTML cannot carry, else `undefined`. */
export function unrepresentableTextDiagnostic(what: string, text: string): Diagnostic | undefined {
  const match = UNREPRESENTABLE.exec(text);
  if (match === null) return undefined;
  const codePoint = `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  return {
    level: 'error',
    message:
      `${what} contains ${codePoint}, which HTML cannot carry: ` +
      'the browser drops it or reads it as U+FFFD. Remove it.',
  };
}

/**
 * Errors for the text of `story` and of the passages it writes (`passages`) that HTML cannot carry: names, tags,
 * passage text, the layout metadata the output mode writes (`layout`: Twine 2 writes `position` and `size`, Twine 1
 * only `position`) and the story's own metadata.
 */
export function unrepresentableTextDiagnostics(
  story: ReadonlyStory,
  passages: readonly ReadonlyPassage[],
  layout: readonly ('position' | 'size')[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const check = (what: string, text: string): void => {
    const diagnostic = unrepresentableTextDiagnostic(what, text);
    if (diagnostic !== undefined) diagnostics.push(diagnostic);
  };
  check('The story name', story.name);
  check('The story tags', story.twine2.tags);
  for (const [tag, color] of story.twine2.tagColors) {
    check(`The color of tag "${tag}"`, `${tag}${color}`);
  }
  for (const p of passages) {
    check(`The name of passage "${p.name}"`, p.name);
    check(`The text of passage "${p.name}"`, p.text);
    for (const field of layout) {
      const value = p.metadata?.[field];
      if (typeof value === 'string') check(`The ${field} of passage "${p.name}"`, value);
    }
    for (const tag of p.tags) {
      check(`The tag "${tag}" of passage "${p.name}"`, tag);
      const fields = splitTweeFields(tag);
      if (fields.length !== 1 || fields[0] !== tag) {
        diagnostics.push({
          level: 'error',
          message:
            `The tag ${JSON.stringify(tag)} of passage "${p.name}" is empty or contains white space; ` +
            'tags are written space-separated, so it would not read back as this tag.',
        });
      }
    }
  }
  return diagnostics;
}

/** The text of a script or style element, made of parts that each came from somewhere. */
export interface CodeText {
  readonly text: string;
  /**
   * Where each part starts in `text`, in order, and what names it in diagnostics (such as
   * `script passage "Story JavaScript"` or `module "lib.js"`).
   */
  readonly parts: readonly [CodePart, ...CodePart[]];
}

/** A part of the text of a script or style element. */
export interface CodePart {
  readonly label: string;
  readonly start: number;
}

/**
 * Warnings for code written into a `script` (JavaScript) or `style` (CSS) element: a carriage return, which the
 * HTML parser turns into a line feed, and each `</script`, `</style` or `<!--` that the escaper writes with a
 * backslash (`scriptContentEscape()`, `styleContentEscape()`) where the backslash changes the code: outside a
 * string, comment or regular expression literal, in a tagged template, or in a `u` or `v` regular expression (for
 * `<\!--`). Where it does not change the code, decompiling still returns the escaped text.
 */
export function codeEscapeDiagnostics(kind: 'script' | 'style', code: CodeText): Diagnostic[] {
  const { text, parts } = code;
  const where = (offset: number, what: string): string => {
    const part = parts.reduce((found, p) => (p.start <= offset ? p : found), parts[0]);
    return `The ${part.label} has ${what} at line ${text.slice(part.start, offset).split('\n').length}`;
  };
  const diagnostics: Diagnostic[] = [];
  // One warning for the first carriage return of each part.
  const carriageReturns = parts.flatMap((part, i) => {
    const offset = text.slice(part.start, parts[i + 1]?.start ?? text.length).indexOf('\r');
    return offset === -1 ? [] : [part.start + offset];
  });
  for (const offset of carriageReturns) {
    diagnostics.push({
      level: 'warning',
      message:
        where(offset, 'a carriage return') + `, which the HTML parser reads as a line feed in a ${kind} element.`,
    });
  }
  for (const site of changingEscapes(kind, text)) {
    diagnostics.push({
      level: 'warning',
      message:
        where(site.offset, JSON.stringify(site.sequence)) +
        ' outside a string, comment or regular expression literal; it is written with a backslash after the "<" ' +
        `so that the HTML parser does not end the ${kind} element there, which changes the code.`,
    });
  }
  return diagnostics;
}

/** The escape sites in `text` where the inserted backslash changes the code. */
function changingEscapes(kind: 'script' | 'style', text: string): EscapeSite[] {
  const sites = kind === 'script' ? scriptEscapeSites(text) : styleEscapeSites(text);
  if (sites.length === 0) return [];
  const ranges = sites.map((site) => ({ start: site.offset, end: site.offset + site.sequence.length, site }));
  if (kind === 'style') {
    return cssContexts(text, ranges).flatMap(({ range, context }) => (context.kind === 'code' ? [range.site] : []));
  }
  return javaScriptContexts(text, ranges).flatMap(({ range, context }) =>
    escapeChangesCode(range.site, context) ? [range.site] : [],
  );
}

/** Whether writing a backslash after the `<` of `site`, in JavaScript `context`, changes the code. */
function escapeChangesCode(site: EscapeSite, context: JavaScriptContext): boolean {
  switch (context.kind) {
    case 'string':
    case 'block-comment':
      return false;
    case 'line-comment':
      // `<\!--` no longer opens the HTML-like comment that `<!--` opened.
      return context.start === site.offset;
    case 'template':
      return context.tagged;
    case 'regexp':
      return site.sequence === '<!--' && /[uv]/.test(context.flags);
    case 'code':
    case 'unparsable':
      return true;
    default: {
      const _exhaustive: never = context;
      throw new Error(`Unhandled JavaScript context: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
