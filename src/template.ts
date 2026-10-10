/**
 * Story format template filling.
 *
 * Placeholders are found in the template text before anything is inserted, so inserted text (a story title,
 * passage data, a start passage name, module or head file content) is never scanned for placeholders. Where each
 * placeholder sits, and where the head ends and the Twine 1 store area starts, is read from one parse of the
 * template (see `html-structure.ts`), and each value is escaped for the context it lands in.
 */
import type { Diagnostic } from './types.js';
import {
  analyzeTemplate,
  contentStaysInHead,
  locateHeadEnd,
  locateStoreArea,
  locateTextContainer,
  replacementIsLiveElement,
  STORE_AREA_DESCRIPTION,
} from './html-structure.js';
import type { HeadPlacement, PlaceholderOccurrence, PlaceholderSite } from './html-structure.js';
import { escapeForContext, htmlEscape, jsStringEscape } from './escape.js';
import type { InsertionContext } from './escape.js';

/** What replaces a placeholder. */
export type PlaceholderValue =
  /** Text, escaped for the context of each occurrence (the story name; Twine 1 `"VERSION"` and `"TIME"`). */
  | { readonly kind: 'text'; readonly text: string }
  /**
   * HTML elements, inserted as they are, only where they become elements of the page (the story data). `probe` is
   * an empty element of the kind `html` starts with, which is inserted to check that. `comment` (the IFID comment)
   * goes before them, or, where the placeholder is inside an element of the template's own rather than `body`,
   * before that element: so that element's child nodes are the ones its template gives it (SugarCube 1 reads its
   * store area's first child node as the story data).
   */
  | { readonly kind: 'markup'; readonly html: string; readonly probe: string; readonly comment?: string }
  /**
   * Text whose placeholder's quotes become the quotes of a JavaScript string literal (`"START_AT"`) or of an
   * attribute value (`data-size="STORY_SIZE"`), as Tweego writes them; elsewhere the quotes are kept as text.
   */
  | { readonly kind: 'quoted'; readonly text: string };

/** A placeholder of a story format template. */
export interface Placeholder {
  /** The placeholder as written, delimiters included: `{{STORY_NAME}}`, or `"STORY"` for Twine 1. */
  readonly token: string;
  /** Replace only the first occurrence that takes the value, or every occurrence. */
  readonly occurrences: 'first' | 'all';
  readonly value: PlaceholderValue;
}

/** A story format template to fill. */
export interface TemplateFill {
  /** The template text, where placeholders are looked for. */
  readonly template: string;
  readonly placeholders: readonly Placeholder[];
  /**
   * For a pre-1.4 Twine 1 format: the story data and the footer that follow the template, and an element the parser
   * reads as it reads the data (see `storyDataProbe()`). The head content and the store area comment may go into the
   * footer; placeholders there are left alone (as Tweego leaves them).
   */
  readonly tail?: { readonly data: string; readonly footer: string; readonly probe: string } | undefined;
  /** Content for the end of the head (modules and the head file). Nothing is inserted when it is empty. */
  readonly head?: string | undefined;
  /** A comment for before the Twine 1 store area element (the IFID comment). */
  readonly beforeStoreArea?: string | undefined;
  /** Names the template in diagnostics, such as `Story format "Harlowe" 3.3.9`. */
  readonly owner: string;
}

/** A filled template, and the warnings about it. */
export interface FilledTemplate {
  readonly output: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** An edit of the template text: replace `[start, end)` with `text` (an insertion when `start === end`). */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Fill a story format template: placeholders, head content and the store area comment. */
export function fillFormatTemplate(fill: TemplateFill): FilledTemplate {
  const { template, tail, owner } = fill;
  // The story data of a pre-1.4 Twine 1 format, between the template and the footer, is a sequence of tiddler
  // elements; one stands in for it while the template and footer are parsed together.
  const sentinel = tail === undefined || tail.data === '' ? '' : tail.probe;
  const document = tail === undefined ? template : template + sentinel + tail.footer;
  const found = findPlaceholders(template, fill.placeholders);
  const analysis = analyzeTemplate(document, found);
  const diagnostics: Diagnostic[] = [];
  const edits: Edit[] = [];

  for (const placeholder of fill.placeholders) {
    const occurrences = found.flatMap((occurrence, i) => {
      const site = analysis.sites[i];
      return occurrence.placeholder === placeholder && site !== undefined ? [{ occurrence, site }] : [];
    });
    const locate: MarkupLocator = {
      isLive: (occurrence, probe) =>
        replacementIsLiveElement(analysis.marked, analysis.doc, occurrence.start, occurrence.end, probe),
      container: (occurrence) => locateTextContainer(analysis.doc, occurrence.start),
    };
    const placed = placeholderEdits(document, placeholder, occurrences, owner, locate);
    edits.push(...placed.edits);
    diagnostics.push(...placed.diagnostics);
  }

  const head = fill.head ?? '';
  if (head !== '') {
    const placement = locateHeadEnd(analysis.marked, analysis.doc);
    diagnostics.push(...headDiagnostics(placement, owner, document));
    if (placement !== undefined) {
      // On its own line, as Tweego writes it; but where the head has already ended, the line break would be text
      // after the head, so it is left out there.
      const stays = (text: string): boolean =>
        contentStaysInHead(analysis.marked, analysis.doc, placement.offset, text);
      let content = `${head}\n`;
      if (placement.how !== 'end-tag' && !stays(content) && stays(head)) content = head;
      if (!stays(content)) {
        diagnostics.push({
          level: 'warning',
          message:
            `The modules and head file content injected into the head of ${owner} do not stay in the head: ` +
            'they hold text, body elements, or an unclosed comment, element or attribute, which changes how the ' +
            'rest of the page is read.',
        });
      }
      edits.push({ start: placement.offset, end: placement.offset, text: content });
    }
  }

  if (fill.beforeStoreArea !== undefined) {
    const at = locateStoreArea(analysis.doc);
    if (at === undefined) {
      diagnostics.push({
        level: 'warning',
        message: `${owner} has no ${STORE_AREA_DESCRIPTION}; the IFID comment was not added.`,
      });
    } else {
      edits.push({ start: at, end: at, text: fill.beforeStoreArea });
    }
  }

  if (tail !== undefined) {
    edits.push({ start: template.length, end: template.length + sentinel.length, text: tail.data });
  }
  return { output: applyEdits(document, edits), diagnostics };
}

/** An occurrence of a placeholder in the template. */
interface Found extends PlaceholderOccurrence {
  readonly placeholder: Placeholder;
}

/** Every occurrence of the placeholders in `template`, left to right and not overlapping. */
function findPlaceholders(template: string, placeholders: readonly Placeholder[]): Found[] {
  if (placeholders.length === 0) return [];
  const tokens = new Map(placeholders.map((placeholder) => [placeholder.token, placeholder]));
  const pattern = new RegExp(
    [...tokens.keys()].map((token) => token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'),
    'g',
  );
  return [...template.matchAll(pattern)].flatMap((match) => {
    const placeholder = tokens.get(match[0]);
    if (placeholder === undefined) return [];
    const start = match.index;
    const end = start + match[0].length;
    const delimiter = match[0].startsWith('{{') ? 2 : 1;
    return [{ placeholder, start, end, innerStart: start + delimiter, innerEnd: end - delimiter }];
  });
}

/** Where markup lands in the template. */
interface MarkupLocator {
  /** Whether `probe` written at the occurrence becomes an element of the page (see `replacementIsLiveElement()`). */
  readonly isLive: (occurrence: Found, probe: string) => boolean;
  /** The start of the element of the template's own that holds the occurrence (see `locateTextContainer()`). */
  readonly container: (occurrence: Found) => number | undefined;
}

/** The edits for one placeholder, given each of its occurrences and where it sits. */
function placeholderEdits(
  document: string,
  placeholder: Placeholder,
  occurrences: readonly { readonly occurrence: Found; readonly site: PlaceholderSite }[],
  owner: string,
  locate: MarkupLocator,
): { edits: Edit[]; diagnostics: Diagnostic[] } {
  const replace = ({ occurrence, site }: { occurrence: Found; site: PlaceholderSite }): string | undefined => {
    const { value } = placeholder;
    if (value.kind === 'markup') {
      const { context, delimiters } = site;
      const inText = delimiters === 'inside' && context.kind === 'text';
      return inText && locate.isLive(occurrence, value.probe) ? value.html : undefined;
    }
    return replacementFor(value, site, document.slice(0, occurrence.start), document.slice(occurrence.end));
  };
  // The markup's comment goes before the element of the template's own that holds a live placeholder, else first.
  const edit = (occurrence: Found, text: string, live: boolean): Edit[] => {
    const { value } = placeholder;
    const comment = value.kind === 'markup' ? value.comment : undefined;
    const container = comment !== undefined && live ? locate.container(occurrence) : undefined;
    if (comment === undefined) return [{ start: occurrence.start, end: occurrence.end, text }];
    if (container === undefined) return [{ start: occurrence.start, end: occurrence.end, text: comment + text }];
    return [
      { start: container, end: container, text: comment },
      { start: occurrence.start, end: occurrence.end, text },
    ];
  };

  if (placeholder.occurrences === 'first') {
    for (const entry of occurrences) {
      const text = replace(entry);
      if (text !== undefined) return { edits: edit(entry.occurrence, text, true), diagnostics: [] };
    }
    const [first] = occurrences;
    if (first === undefined) return { edits: [], diagnostics: [] };
    return {
      edits: edit(first.occurrence, fallbackFor(placeholder.value), false),
      diagnostics: [unsupportedSite(placeholder, first, owner, document)],
    };
  }

  const edits: Edit[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of occurrences) {
    const text = replace(entry);
    if (text === undefined) diagnostics.push(unsupportedSite(placeholder, entry, owner, document));
    edits.push(...edit(entry.occurrence, text ?? fallbackFor(placeholder.value), text !== undefined));
  }
  return { edits, diagnostics };
}

/**
 * What replaces a text placeholder at `site`, between the template texts `before` and `after`, or `undefined` when
 * the value cannot be written there.
 */
function replacementFor(
  value: Exclude<PlaceholderValue, { kind: 'markup' }>,
  site: PlaceholderSite,
  before: string,
  after: string,
): string | undefined {
  const { context, delimiters } = site;
  if (value.kind === 'text') {
    return delimiters === 'inside' ? escapeAtBoundary(value.text, context, before, after) : undefined;
  }
  // A quoted placeholder: its quotes are a JavaScript string literal's, an attribute value's, or text.
  if (delimiters === 'string') return `"${jsStringEscape(value.text)}"`;
  if (delimiters === 'attribute') return `"${htmlEscape(value.text)}"`;
  if (delimiters === 'split') return undefined;
  const text = escapeAtBoundary(value.text, context, `${before}"`, `"${after}`);
  return text === undefined ? undefined : `"${text}"`;
}

/** What Tweego writes for a value in a place twee-ts cannot escape for. */
function fallbackFor(value: PlaceholderValue): string {
  if (value.kind === 'markup') return value.html;
  return value.kind === 'text' ? htmlEscape(value.text) : `"${jsStringEscape(value.text)}"`;
}

/** Matches text ending in an unfinished character reference (`&`, `&am`, `&#x4`), which a following character extends. */
const REFERENCE_START = /&[0-9A-Za-z#]*$/;
/** Matches text ending in a `<` that a following letter, `/`, `!` or `?` makes a tag, end tag or comment. */
const TAG_START = /<\/?[A-Za-z]*$/;
/** The sequences that change how the HTML tokenizer reads script text: the escape states and the end tag. */
const SCRIPT_SEQUENCES = /<!--|-->|<\/?script[\t\n\f\r />]/gi;
/** The same, in script text with no `<!--` before: only an escaped state ends at `-->`, and there is none. */
const PLAIN_SCRIPT_SEQUENCES = /<!--|<\/?script[\t\n\f\r />]/gi;
/** The sequence that ends style text. */
const STYLE_SEQUENCES = /<\/style[\t\n\f\r />]/gi;
/** Matches text ending in an odd number of backslashes, which escape the character that follows. */
const ESCAPING_BACKSLASH = /(?<!\\)(?:\\\\)*\\$/;

/** A context whose text has no escapes: a JavaScript or CSS comment. */
type CodeContext = Extract<InsertionContext, { kind: 'script' | 'json' | 'style' }>;

function isCodeComment(context: CodeContext): boolean {
  if (context.kind === 'style') return context.css.kind === 'comment';
  return context.js.kind === 'block-comment' || context.js.kind === 'line-comment';
}

/**
 * Escape `value` for `context` (see `escapeForContext()`), so that it also forms nothing with the template text
 * around it: a character reference started before it, a tag, end tag or comment after a `<`, a `</script`, `<!--`
 * or `-->` in a script, a JavaScript or CSS escape sequence, a template substitution, or the end of a comment.
 * `undefined` when no escaping can avoid that.
 */
function escapeAtBoundary(value: string, context: InsertionContext, before: string, after: string): string | undefined {
  const escaped = escapeForContext(value, context);
  if (escaped === undefined) return undefined;
  // Where the parser drops a line feed right after the start tag, one more keeps the line feed that follows.
  const extraNewline =
    context.kind === 'text' && context.dropsLeadingNewline && /^[\n\r]/.test(escaped + after) ? '\n' : '';
  if (escaped === '') return extraNewline === '' && startGlues(context, before, after) ? undefined : extraNewline;
  let text = escaped;
  if (startGlues(context, before, text)) {
    if (context.kind !== 'style' && context.kind !== 'script' && context.kind !== 'json') {
      text = `&#${text.charCodeAt(0)};${text.slice(1)}`;
    } else if (isCodeComment(context)) {
      text = ` ${text}`;
    } else if (ESCAPING_BACKSLASH.test(before)) {
      // A backslash before the value escapes its first character, whatever that is.
      return undefined;
    } else {
      text = codeEscape(context, text.charAt(0)) + text.slice(1);
    }
  }
  if (endGlues(context, text, after)) {
    text = isCodeComment(context) ? `${text} ` : text.slice(0, -1) + codeEscape(context, '-');
  }
  return extraNewline + text;
}

/**
 * Whether escaped `text` ends where it forms something with the template text `after`: `-->` in script text (the
 * text holds no `<`), or `*\/` in a JavaScript or CSS block comment.
 */
function endGlues(context: InsertionContext, text: string, after: string): context is CodeContext {
  switch (context.kind) {
    case 'script':
    case 'json':
      if (context.js.kind === 'block-comment' && text.endsWith('*') && after.startsWith('/')) return true;
      if (!context.escapable) return false;
      return (text.endsWith('--') && after.startsWith('>')) || (text.endsWith('-') && after.startsWith('->'));
    case 'style':
      return context.css.kind === 'comment' && text.endsWith('*') && after.startsWith('/');
    default:
      return false;
  }
}

/** Whether `next`, written after the template text `before` in `context`, would be read together with it. */
function startGlues(context: InsertionContext, before: string, next: string): boolean {
  // Raw text and markup take no value (see `escapeForContext()`).
  if (next === '' || context.kind === 'raw-text' || context.kind === 'markup') return false;
  // The input stream reads a carriage return and a line feed after it as one line break.
  if (before.endsWith('\r') && next.startsWith('\n')) return true;
  switch (context.kind) {
    case 'text':
      return (
        (REFERENCE_START.test(before) && /^[0-9A-Za-z#;=]/.test(next)) ||
        (TAG_START.test(before) && /^[A-Za-z!/?]/.test(next))
      );
    case 'attribute':
      return REFERENCE_START.test(before) && /^[0-9A-Za-z#;=]/.test(next);
    case 'comment':
      return (
        // A bogus comment opened by `</` or `<!` is an end tag or a doctype, CDATA section or comment with a letter,
        // `[` or `-` after it, and nothing with `>` right after `</`.
        (before.endsWith('</') && /^[A-Za-z>]/.test(next)) ||
        (before.endsWith('<!') && /^[A-Za-z[-]/.test(next)) ||
        (before.endsWith('-') && next.startsWith('-')) ||
        (before.endsWith('--') && /^[!>]/.test(next)) ||
        (before.endsWith('--!') && next.startsWith('>'))
      );
    case 'style':
      if (spansBoundary(STYLE_SEQUENCES, before, next)) return true;
      return isCodeComment(context) ? before.endsWith('*') && next.startsWith('/') : ESCAPING_BACKSLASH.test(before);
    case 'script':
    case 'json':
      if (spansBoundary(context.escapable ? SCRIPT_SEQUENCES : PLAIN_SCRIPT_SEQUENCES, before, next)) return true;
      if (isCodeComment(context))
        return context.js.kind === 'block-comment' && before.endsWith('*') && next.startsWith('/');
      // (A template literal's `${` cannot form: `$` right before a placeholder's `{{` would already be one.)
      return ESCAPING_BACKSLASH.test(before);
    default: {
      const _unhandled: never = context;
      throw new Error(`Unhandled context at a boundary: ${JSON.stringify(_unhandled)}`);
    }
  }
}

/** Whether `pattern` matches `before` followed by `next` across the boundary between them, but in neither alone. */
function spansBoundary(pattern: RegExp, before: string, next: string): boolean {
  // The longest sequence, `</script` and a space, has 9 characters.
  const tail = before.slice(-8);
  const window = tail + next.slice(0, 8);
  return [...window.matchAll(pattern)].some((m) => m.index < tail.length && m.index + m[0].length > tail.length);
}

/** `ch` written as an escape sequence of a JavaScript, JSON or CSS string or template literal. */
function codeEscape(context: CodeContext, ch: string): string {
  const hex = ch.charCodeAt(0).toString(16);
  return CODE_ESCAPES[context.kind](hex);
}

/** A character code (in hex) as an escape sequence of a CSS string, a JSON string or a JavaScript literal. */
const CODE_ESCAPES: Readonly<Record<CodeContext['kind'], (hex: string) => string>> = {
  style: (hex) => `\\${hex} `,
  json: (hex) => `\\u${hex.padStart(4, '0')}`,
  script: (hex) => `\\u{${hex}}`,
};

/** Describe an insertion context for a diagnostic. */
function describeContext(site: PlaceholderSite): string {
  const { context } = site;
  if (site.delimiters === 'split' && context.kind !== 'markup') return 'where its delimiters are read apart from it';
  if (context.kind === 'text') return 'in text';
  if (context.kind === 'attribute')
    return context.quote === '' ? 'in an unquoted attribute value' : 'in an attribute value';
  if (context.kind === 'comment') return 'in a comment';
  if (context.kind === 'script') {
    const { js } = context;
    return `in a script (${js.kind === 'unparsable' ? `unparsable: ${js.reason}` : `JavaScript ${js.kind}`})`;
  }
  if (context.kind === 'json') return `in a JSON script (${context.js.kind})`;
  if (context.kind === 'style') return `in a style element (CSS ${context.css.kind})`;
  if (context.kind === 'raw-text') return `in the raw text of a "${context.element}" element`;
  return 'inside a tag or doctype, or where the HTML parser drops it';
}

function unsupportedSite(
  placeholder: Placeholder,
  entry: { readonly occurrence: Found; readonly site: PlaceholderSite },
  owner: string,
  document: string,
): Diagnostic {
  const { line, column } = lineAndColumn(document, entry.occurrence.start);
  const what =
    placeholder.value.kind === 'markup'
      ? 'is not where the HTML parser reads it as elements of the page, so the browser will not see the inserted story data'
      : 'is in a place twee-ts cannot escape a value for, so the value may be changed or break the page';
  return {
    level: placeholder.value.kind === 'markup' ? 'error' : 'warning',
    message:
      `${owner}: the placeholder ${placeholder.token} at line ${line}, column ${column} is ` +
      `${describeContext(entry.site)}; it ${what}. It was replaced as Tweego replaces it.`,
  };
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}

/** The warning about where the head content went, or none when it went before the closing head tag. */
function headDiagnostics(placement: HeadPlacement | undefined, owner: string, document: string): Diagnostic[] {
  if (placement === undefined) {
    return [
      {
        level: 'warning',
        message: `${owner} has no place in its head for the modules and head file; they were not injected.`,
      },
    ];
  }
  if (placement.how === 'end-tag') return [];
  const { line, column } = lineAndColumn(document, placement.offset);
  return [
    {
      level: 'warning',
      message:
        `${owner} has no closing head tag that ends its head; the modules and head file were injected ` +
        `where the head ends, at line ${line}, column ${column}.`,
    },
  ];
}

/** Apply non-overlapping edits to `text`; an insertion goes before a replacement that starts at the same offset. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));
  let output = '';
  let at = 0;
  for (const edit of sorted) {
    output += text.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return output + text.slice(at);
}
