/**
 * Passage word counts. Every scan here is linear in the text: passage text is untrusted and may be large, so no
 * pattern here may backtrack over it.
 */
import type { WordCountMethod } from './types.js';
import { splitTweeFields } from './twee-syntax.js';
import { readSquareBracketedMarkup } from './link-markup.js';

/**
 * The first index of a character at or after a position, for positions that never decrease: each search
 * starts where the last one for that character ended, so all searches together take linear time.
 */
class ForwardFinder {
  private readonly found = new Map<string, number>();
  constructor(private readonly text: string) {}

  next(ch: string, from: number): number {
    const last = this.found.get(ch);
    // -1: no `ch` at or after an earlier position, so none at or after this one either.
    if (last !== undefined && (last === -1 || last >= from)) return last;
    const at = this.text.indexOf(ch, from);
    this.found.set(ch, at);
    return at;
  }
}

/** The comment forms Tweego strips before counting: `/% %/`, `/* *\/` and `<!-- -->`. */
const COMMENTS: readonly (readonly [open: string, close: string])[] = [
  ['/%', '%/'],
  ['/*', '*/'],
  ['<!--', '-->'],
];

/**
 * `text` without comments, as Tweego's `(?s:/%.*?%/|/\*.*?\*\/|<!--.*?-->)` removes them: from the leftmost
 * opening delimiter to the first closing one after it. An opening delimiter with no closing one after it is
 * kept, and so is everything after it.
 */
export function stripComments(text: string): string {
  // A closing delimiter not found from some position is not found from any later one.
  const missing = new Set<string>();
  let out = '';
  let kept = 0;
  let i = 0;
  while (i < text.length) {
    const comment = COMMENTS.find(([open, close]) => !missing.has(close) && text.startsWith(open, i));
    if (comment === undefined) {
      i++;
      continue;
    }
    const [open, close] = comment;
    const end = text.indexOf(close, i + open.length);
    if (end === -1) {
      missing.add(close);
      i++;
      continue;
    }
    out += text.slice(kept, i);
    i = end + close.length;
    kept = i;
  }
  return out + text.slice(kept);
}

// --- Normalization segments (Tweego's `norm.Iter`) ---

/**
 * Code points with canonical combining class 0 that NFC may still combine with the character before them
 * (Unicode NFC_Quick_Check=Maybe): Hangul medial vowels and final consonants, and some vowel and length
 * signs. Go's `norm` package starts no new segment before them. Derived from the Unicode 16 data.
 */
const COMBINING_STARTERS: ReadonlySet<string> = new Set(
  [
    0x09be,
    0x09d7,
    0x0b3e,
    0x0b56,
    0x0b57,
    0x0bbe,
    0x0bd7,
    0x0cc2,
    0x0cd5,
    0x0cd6,
    0x0d3e,
    0x0d57,
    0x0dcf,
    0x0ddf,
    0x102e,
    ...codePoints(0x1161, 0x1175),
    ...codePoints(0x11a8, 0x11c2),
    0x1b35,
    0x11127,
    0x1133e,
    0x11357,
    0x113b8,
    0x113bb,
    0x113c2,
    0x113c9,
    0x114b0,
    0x114ba,
    0x114bd,
    0x115af,
    0x11930,
    ...codePoints(0x1611e, 0x16120),
    0x16129,
    0x16d67,
  ].map((cp) => String.fromCodePoint(cp)),
);

/** The code points from `from` to `to`, both included. */
function codePoints(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** How a code point of decomposed text takes part in segmentation. */
type SegmentRole = 'starter' | 'combining-starter' | 'non-starter';

const roles = new Map<string, SegmentRole>();

/** Whether a code point has a non-zero canonical combining class: canonical reordering moves it. */
function isNonStarter(ch: string): boolean {
  // Every character with a non-zero combining class is a mark; testing that first is cheap.
  if (!/\p{M}/u.test(ch)) return false;
  // Reordering puts a lower class first: U+0334 has class 1, U+05B0 class 10.
  const after = 'a' + ch + '\u0334';
  const before = 'a\u05b0' + ch;
  return after.normalize('NFD') !== after || before.normalize('NFD') !== before;
}

function segmentRole(ch: string): SegmentRole {
  const known = roles.get(ch);
  if (known !== undefined) return known;
  const role: SegmentRole = isNonStarter(ch)
    ? 'non-starter'
    : COMBINING_STARTERS.has(ch)
      ? 'combining-starter'
      : 'starter';
  roles.set(ch, role);
  return role;
}

/** The most non-starters in one segment; more start a new one, as in Go's stream-safe text handling. */
const MAX_NON_STARTERS = 30;

/**
 * The number of normalization segments Go's `norm.Iter` yields for `text` in NFKD: each starts at a starter
 * (a character with combining class 0 that does not combine with the one before it) and holds the characters
 * that follow it up to the next one, so `é` (`e` and U+0301 in NFKD) is one segment and a Hangul syllable
 * (three jamo) is one.
 */
export function countNormalizationSegments(text: string): number {
  let segments = 0;
  let nonStarters = 0;
  for (const ch of text.normalize('NFKD')) {
    const role = ch < '\u0300' ? 'starter' : segmentRole(ch);
    if (segments === 0 || role === 'starter') {
      segments++;
      nonStarters = role === 'non-starter' ? 1 : 0;
    } else if (role === 'combining-starter') {
      nonStarters = 0;
    } else if (++nonStarters > MAX_NON_STARTERS) {
      segments++;
      nonStarters = 1;
    }
  }
  return segments;
}

// --- Markup removal for the 'whitespace' method ---

/**
 * What a markup form is at a position where it may start: a match (its end, and the text that replaces it),
 * `none` when it does not match there, or `never` when it matches neither there nor anywhere later.
 */
type MarkupMatch = { readonly end: number; readonly replacement: string } | 'none' | 'never';

/**
 * Replace each match of a markup form in `text`, leftmost first and without overlaps, as a global regular
 * expression replace does. A match can start only at an occurrence of `open`; `matchAt` decides whether one
 * does, finding the characters it needs with `finder`, whose searches only move forward. Linear time.
 */
function replaceMarkup(
  text: string,
  open: string,
  matchAt: (start: number, finder: ForwardFinder) => MarkupMatch,
): string {
  const finder = new ForwardFinder(text);
  let out = '';
  let kept = 0;
  for (let i = text.indexOf(open); i !== -1;) {
    const match = matchAt(i, finder);
    if (match === 'never') break;
    if (match === 'none') {
      i = text.indexOf(open, i + 1);
      continue;
    }
    out += text.slice(kept, i) + match.replacement;
    kept = match.end;
    i = text.indexOf(open, kept);
  }
  return out + text.slice(kept);
}

/** `text` without SugarCube macro calls: `<<` up to the first `>` after it, when another `>` follows that. */
function stripMacros(text: string): string {
  return replaceMarkup(text, '<<', (i, finder) => {
    const gt = finder.next('>', i + 2);
    if (gt === -1) return 'never';
    return text[gt + 1] === '>' ? { end: gt + 2, replacement: '' } : 'none';
  });
}

/**
 * `text` with each SugarCube link, `[[Link]]`, `[[Text|Link]]`, `[[Text->Link]]` or `[[Link<-Text]]`, with or
 * without a setter, replaced by the text it displays. Links are read as `readSquareBracketedMarkup` reads them,
 * within an allowance of four times the text plus a fixed one, so the time stays linear.
 */
function linksToText(text: string): string {
  const budget = { left: 4 * text.length + 100_000 };
  return replaceMarkup(text, '[[', (i) => {
    const markup = readSquareBracketedMarkup(text, i, budget);
    return markup?.label === undefined ? 'none' : { end: markup.end, replacement: markup.label };
  });
}

/** `text` without HTML tags: `<`, at least one character, then the first `>`. */
function stripTags(text: string): string {
  return replaceMarkup(text, '<', (i, finder) => {
    const gt = finder.next('>', i + 1);
    if (gt === -1) return 'never';
    return gt > i + 1 ? { end: gt + 1, replacement: '' } : 'none';
  });
}

/**
 * Count the words of passage text.
 *
 * - `'tweego'` (default), as Tweego counts them: line feeds and comments are removed, the rest is decomposed
 *   (NFKD) and its normalization segments counted (a letter with its accents is one), and every five, or
 *   part of five, make a word.
 * - `'whitespace'`: comments, macro calls (`<<…>>`), link markup (keeping the link text) and HTML tags are
 *   removed, and the runs of non-white-space characters counted.
 */
export function countTextWords(text: string, method: WordCountMethod): number {
  switch (method) {
    case 'tweego': {
      const count = countNormalizationSegments(stripComments(text.replaceAll('\n', '')));
      return Math.ceil(count / 5);
    }
    case 'whitespace':
      return splitTweeFields(stripTags(linksToText(stripMacros(stripComments(text))))).length;
    default: {
      const _exhaustive: never = method;
      throw new Error(`Unhandled word count method: ${String(_exhaustive)}`);
    }
  }
}
