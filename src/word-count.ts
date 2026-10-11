/**
 * Passage word counts. Every scan here is linear in the text: passage text is untrusted and may be large, so no
 * pattern here may backtrack over it.
 */
import type { WordCountMethod } from './types.js';
import { splitTweeFields } from './twee-syntax.js';
import { htmlEndTagAt, walkPassageMarkup } from './sugarcube-macros.js';
import type { OwnElement } from './sugarcube-macros.js';
import { HtmlNestingError, htmlText } from './html-structure.js';
import { htmlEscape } from './escape.js';

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
 * signs. Go's `norm` package counts them as non-starters for stream-safe text, so it starts no new segment
 * before them, except after it has reordered. Derived from the Unicode 16 data.
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

/** Whether a code point of decomposed text has a non-zero canonical combining class: canonical reordering moves it. */
function isNonStarter(ch: string): boolean {
  // Every character with a non-zero combining class is a mark; testing that first is cheap.
  if (!/\p{M}/u.test(ch)) return false;
  // Reordering puts a lower class first: U+0334 has class 1, U+05B0 class 10.
  const after = 'a' + ch + '̴';
  const before = 'aְ' + ch;
  return after.normalize('NFD') !== after || before.normalize('NFD') !== before;
}

const nonStarters = new Map<string, boolean>();

/** Whether a code point of decomposed text (or `''`, for none) has combining class 0. */
function hasZeroClass(ch: string): boolean {
  if (ch < '̀') return true;
  let known = nonStarters.get(ch);
  if (known === undefined) {
    known = isNonStarter(ch);
    nonStarters.set(ch, known);
  }
  return !known;
}

const lowerClasses = new Map<string, boolean>();

/**
 * Whether the combining class of `a` is lower than that of `b`, both code points of decomposed text (or `''`,
 * class 0): canonical reordering moves `a` before `b` exactly when it is.
 */
function hasLowerClass(a: string, b: string): boolean {
  if (hasZeroClass(b)) return false;
  if (hasZeroClass(a)) return true;
  const key = `${a} ${b}`;
  let known = lowerClasses.get(key);
  if (known === undefined) {
    const text = 'a' + b + a;
    known = text.normalize('NFD') !== text;
    lowerClasses.set(key, known);
  }
  return known;
}

/**
 * Whether a code point of decomposed text is a starter for Go's `norm` package (`BoundaryBefore`): combining
 * class 0, and not one that combines with the character before it.
 */
function isBoundary(ch: string): boolean {
  return hasZeroClass(ch) && !COMBINING_STARTERS.has(ch);
}

/** What Go's NFKD tables hold for a character of the source text (its `Properties`). */
interface CharInfo {
  /** A Hangul syllable, which Go decomposes by computation rather than from its tables. */
  readonly hangul: boolean;
  /** The NFKD decomposition, when the character has one. */
  readonly decomposition: readonly string[] | undefined;
  /** The code point whose combining class is the character's leading one (`ccc`), or `''` for class 0. */
  readonly lead: string;
  /** The code point whose combining class is the character's trailing one (`tccc`), or `''` for class 0. */
  readonly trail: string;
  /** Leading non-starters: code points of class above 0, or that combine with what precedes them. */
  readonly nLead: number;
  /** Trailing non-starters. */
  readonly nTrail: number;
  /** Whether the decomposition holds more than one segment, which Go yields one by one. */
  readonly multiSegment: boolean;
}

/** Any ASCII character: Go's iterator takes each as a segment of its own. */
const ASCII_INFO: CharInfo = {
  hangul: false,
  decomposition: undefined,
  lead: '',
  trail: '',
  nLead: 0,
  nTrail: 0,
  multiSegment: false,
};
/** Go's empty `Properties`, which the iterator reads past the end of the text. */
const END_INFO: CharInfo = { ...ASCII_INFO };

const HANGUL_T_COUNT = 28;

const infos = new Map<string, CharInfo>();

function charInfo(ch: string): CharInfo {
  if (ch < '\u0080') return ASCII_INFO;
  let info = infos.get(ch);
  if (info === undefined) {
    info = computeCharInfo(ch);
    infos.set(ch, info);
  }
  return info;
}

function computeCharInfo(ch: string): CharInfo {
  if (ch >= '가' && ch <= '힣') {
    // A leading consonant, a vowel and, unless the syllable has none, a trailing consonant; the last two combine.
    const trailing = (ch.charCodeAt(0) - 0xac00) % HANGUL_T_COUNT === 0 ? 1 : 2;
    return { ...ASCII_INFO, hangul: true, nTrail: trailing };
  }
  const runes = Array.from(ch.normalize('NFKD'));
  const lead = runes.slice(0, 1).join('');
  const trail = runes.slice(-1).join('');
  const firstStarter = runes.findIndex(isBoundary);
  const nLead = firstStarter === -1 ? runes.length : firstStarter;
  return {
    hangul: false,
    decomposition: runes.length === 1 && lead === ch ? undefined : runes,
    lead: hasZeroClass(lead) ? '' : lead,
    trail: hasZeroClass(trail) ? '' : trail,
    nLead,
    nTrail: runes.length - 1 - runes.findLastIndex(isBoundary),
    multiSegment: nLead === 0 && hasZeroClass(lead) && runes.slice(1).some(hasZeroClass),
  };
}

/** The most non-starters in one segment; more start a new one, as in Go's stream-safe text handling. */
const MAX_NON_STARTERS = 30;

/** Which of Go's `Iter.next` functions yields the next segment. */
type IterStep = 'decomposed' | 'ascii' | 'hangul' | 'multi' | 'cgj';

/**
 * Go's `norm.Iter` over a text in NFKD (golang.org/x/text v0.3.2, the version Tweego 2.1.1 is built with), reduced
 * to where its segments end: a port of `nextDecomposed` and the functions it hands over to. The text is read as
 * written, a character (code point) at a time; each method names the Go function it ports.
 *
 * Go also ends a segment when its 128-byte buffer would overflow, which is left out: the 30 non-starter limit
 * always comes first. A segment holds one starter of at most 4 bytes and non-starters that each add at least 1
 * to the count per 4 bytes (a decomposition that leads with a non-starter holds only non-starters), so it holds
 * at most 4 × 31 = 124 bytes.
 */
class SegmentIterator {
  private readonly infos: readonly CharInfo[];
  /** The character the next segment starts at, as `i.p`. */
  private p = 0;
  /** The properties of the current character, as `i.info`. */
  private info: CharInfo;
  /** Go's `streamSafe`: the non-starters in the segment so far. */
  private ss: number;
  private step: IterStep = 'decomposed';
  /** The segments of a multi-segment decomposition still to yield, as `i.multiSeg`; empty for none. */
  private multiSeg: readonly string[] = [];

  constructor(text: string) {
    this.infos = Array.from(text, charInfo);
    this.info = this.at(0);
    this.ss = this.info.nTrail;
  }

  /** Whether no segment is left (`Done`). */
  done(): boolean {
    return this.p >= this.infos.length;
  }

  /** Move past the next segment (`Next`). */
  next(): void {
    switch (this.step) {
      case 'decomposed':
        this.decomposed();
        break;
      case 'ascii':
        this.ascii();
        break;
      case 'hangul':
        this.hangul();
        break;
      case 'multi':
        this.multi();
        break;
      case 'cgj':
        // `nextCGJDecompose`: a grapheme joiner, then the character that overflowed and the non-starters after it.
        this.ss = this.info.nTrail;
        this.step = 'decomposed';
        this.reorder();
        break;
      default: {
        const _exhaustive: never = this.step;
        throw new Error(`Unhandled iterator step: ${String(_exhaustive)}`);
      }
    }
  }

  private at(k: number): CharInfo {
    return this.infos[k] ?? END_INFO;
  }

  /** `streamSafe.next`: whether `next` starts a segment, overflows this one, or joins it. */
  private ssNext(next: CharInfo): 'starter' | 'overflow' | 'joins' {
    this.ss += next.nLead;
    if (this.ss > MAX_NON_STARTERS) {
      this.ss = 0;
      return 'overflow';
    }
    if (next.nLead > 0) return 'joins';
    this.ss = next.nTrail;
    return 'starter';
  }

  /** `nextASCIIString`. */
  private ascii(): void {
    const next = this.at(this.p + 1);
    if (next === END_INFO || next === ASCII_INFO) {
      this.p++;
    } else {
      this.info = this.at(this.p);
      this.step = 'decomposed';
      this.decomposed();
    }
  }

  /** `nextHangul`. */
  private hangul(): void {
    const next = this.at(this.p + 1);
    if (next === END_INFO || next.hangul) {
      this.p++;
      return;
    }
    this.ssNext(this.info);
    this.info = this.at(this.p);
    this.step = 'decomposed';
    this.decomposed();
  }

  /** `nextMulti`: the next segment of a decomposition that holds several. */
  private multi(): void {
    const j = this.multiSeg.findIndex((r, k) => k > 0 && isBoundary(r));
    if (j !== -1) {
      this.multiSeg = this.multiSeg.slice(j);
      return;
    }
    // The last segment, taken as a decomposition of its own.
    this.step = 'decomposed';
    this.decomposed();
  }

  /** `doNormDecomposed`: the character at `p` and the ones of non-zero class after it, reordered. */
  private reorder(): void {
    for (;;) {
      this.p++;
      if (this.done()) return;
      this.info = this.at(this.p);
      if (this.info.lead === '') return;
      if (this.ssNext(this.info) === 'overflow') {
        this.step = 'cgj';
        return;
      }
    }
  }

  /** `nextDecomposed`. */
  private decomposed(): void {
    let first = true;
    for (;;) {
      const { info } = this;
      if (info === ASCII_INFO) {
        this.ss = 0;
        this.p++;
        if (this.done()) return;
        if (this.at(this.p) === ASCII_INFO) {
          this.step = 'ascii';
          return;
        }
      } else if (info.decomposition !== undefined) {
        if (first && info.multiSegment) {
          if (this.multiSeg.length === 0) {
            this.multiSeg = info.decomposition;
            this.step = 'multi';
            this.multi();
            return;
          }
          // The last segment of the decomposition.
          this.multiSeg = [];
        }
        this.p++;
        this.info = this.at(this.p);
        const next = this.ssNext(this.info);
        if (next === 'overflow') this.step = 'cgj';
        if (next !== 'joins') return;
        first = false;
        if (hasLowerClass(this.info.lead, info.trail)) {
          this.reorder();
          return;
        }
        continue;
      } else if (info.hangul) {
        this.p++;
        if (this.done()) return;
        if (this.at(this.p).hangul) {
          this.step = 'hangul';
          return;
        }
      } else {
        this.p++;
      }
      first = false;
      if (this.done()) return;
      this.info = this.at(this.p);
      const next = this.ssNext(this.info);
      if (next === 'starter') return;
      if (next === 'overflow') {
        this.step = 'cgj';
        return;
      }
      if (hasLowerClass(this.info.lead, info.trail)) {
        this.reorder();
        return;
      }
    }
  }
}

/**
 * The number of normalization segments Go's `norm.Iter` yields for `text` in NFKD, which Tweego's word count
 * counts (see `SegmentIterator`). A segment starts at a starter (combining class 0, not combining with what
 * precedes it) and holds the non-starters after it, so `é` is one segment and a Hangul syllable is one. The
 * iterator reads the text as written, not decomposed first: when a character's leading combining class is lower
 * than the trailing class before it, it reorders, and then ends the segment at the next character of class 0,
 * even one that combines with what precedes it (U+0301 U+09BE U+09BE is two segments). More than 30
 * non-starters also end a segment. Character properties come from the JavaScript
 * engine's Unicode data, so characters newer than Go's tables can count differently.
 */
export function countNormalizationSegments(text: string): number {
  const iter = new SegmentIterator(text);
  let segments = 0;
  while (!iter.done()) {
    segments++;
    iter.next();
  }
  return segments;
}

// --- Markup removal for the 'whitespace' method ---

/** Passage text as the `'whitespace'` method reads it, before HTML. */
interface MarkupText {
  /** HTML for `htmlText`: the start and end tags SugarCube reads, and text, in which any other `<` is `&lt;`. */
  readonly html: string;
  /** The text alone, with no tag: what is counted when the HTML can't be read. */
  readonly prose: string;
  /** An `<svg>` element or `<html>` content nests elements more than `MAX_HTML_DEPTH` deep. */
  readonly htmlTooDeep: boolean;
}

/**
 * The elements whose start tags `readMarkup` kept and no end tag has closed yet, innermost last. Each name keeps the
 * places it has on the stack, so finding the innermost element of a name takes constant time, and closing elements
 * takes time in proportion to how many were opened: the work of all calls together is linear.
 */
class OpenElements {
  private readonly names: string[] = [];
  private readonly places = new Map<string, number[]>();

  open(name: string): void {
    const places = this.places.get(name);
    if (places === undefined) {
      this.places.set(name, [this.names.length]);
    } else {
      places.push(this.names.length);
    }
    this.names.push(name);
  }

  /** Closes the innermost open element named `name`, and those opened inside it; false when none is open. */
  close(name: string): boolean {
    const places = this.places.get(name);
    const place = places?.[places.length - 1];
    if (place === undefined) return false;
    while (this.names.length > place) {
      const closed = this.names.pop();
      if (closed !== undefined) this.places.get(closed)?.pop();
    }
    return true;
  }
}

/**
 * Reads passage markup as SugarCube's wikifier walks it (`walkPassageMarkup`), leftmost first: macro tags,
 * `<<script>>` bodies, comments (and the opener of one that isn't closed) and italics markup are dropped, link
 * markup gives the text it shows, a `<script>` element is kept whole, and an HTML start tag that SugarCube's
 * `htmlTag` parser reads is kept, so that a `<<` or `[[` inside its attribute values is not markup. An element
 * SugarCube reads with a parser of its own (`ownElementReader`) is read as that parser reads it: a `<style>` element
 * shows nothing, the text an `<svg>` element or the content of `<html>` shows, read as HTML of its own, is kept as
 * text, and so is the content of `<nowiki>`; without its end, the parser drops its opener, and so does this. In the
 * text between them, an end tag is kept when it closes an element whose start tag was kept, and any other `<` is text.
 *
 * Linear time (see `OpenElements` and `ownElementReader`).
 */
function readMarkup(text: string): MarkupText {
  const html: string[] = [];
  const prose: string[] = [];
  let htmlTooDeep = false;
  const open = new OpenElements();
  const keepText = (part: string): void => {
    html.push(htmlEscape(part));
    prose.push(part);
  };
  /** Reads an element SugarCube reads with a parser of its own, at `start`. */
  const readOwnElement = (start: number, own: OwnElement): void => {
    const { closed } = own;
    if (closed === undefined) return;
    switch (own.kind) {
      case 'style':
        return;
      case 'svg':
      case 'html':
        // SugarCube parses the element (or the content) as HTML of its own, so nothing left open in it reaches
        // what follows. HTML nested too deeply to read gives no text.
        try {
          keepText(
            htmlText(own.kind === 'svg' ? text.slice(start, closed.end) : text.slice(own.openerEnd, closed.contentEnd)),
          );
        } catch (e) {
          if (!(e instanceof HtmlNestingError)) throw e;
          htmlTooDeep = true;
        }
        return;
      case 'nowiki':
        keepText(text.slice(own.openerEnd, closed.contentEnd));
        return;
      default: {
        const _exhaustive: never = own.kind;
        throw new Error(`Unhandled element: ${String(_exhaustive)}`);
      }
    }
  };
  let nextAngle = text.indexOf('<');
  /** The text from `from` to `end`, where the walk read no markup. */
  const between = (from: number, end: number): void => {
    let at = from;
    for (;;) {
      if (nextAngle !== -1 && nextAngle < at) nextAngle = text.indexOf('<', at);
      if (nextAngle === -1 || nextAngle >= end) break;
      const part = text.slice(at, nextAngle);
      html.push(part);
      prose.push(part);
      const endTag = htmlEndTagAt(text, nextAngle);
      if (endTag !== undefined && endTag.end <= end && open.close(endTag.name)) {
        html.push(text.slice(nextAngle, endTag.end));
        at = endTag.end;
      } else {
        html.push('&lt;');
        prose.push('<');
        at = nextAngle + 1;
      }
    }
    const part = text.slice(at, end);
    html.push(part);
    prose.push(part);
  };
  let kept = 0;
  walkPassageMarkup(
    text,
    (region) => {
      between(kept, region.start);
      switch (region.kind) {
        case 'link':
          if (region.label !== undefined) keepText(region.label);
          break;
        case 'html-tag':
          html.push(text.slice(region.start, region.end));
          if (region.tag.container) open.open(region.tag.name);
          break;
        case 'script-element':
          // A complete element is kept for the HTML parser, which leaves its text out; SugarCube reads an opener
          // without a `</script>` and shows nothing for it.
          if (region.complete) html.push(text.slice(region.start, region.end));
          break;
        case 'own-element':
          readOwnElement(region.start, region.element);
          break;
        case 'macro':
        case 'script-body':
        case 'comment':
          break;
        default: {
          const _exhaustive: never = region;
          throw new Error(`Unhandled markup region: ${JSON.stringify(_exhaustive)}`);
        }
      }
      kept = region.end;
    },
    { ownElements: true },
  );
  between(kept, text.length);
  return { html: html.join(''), prose: prose.join(''), htmlTooDeep };
}

const NUL = String.fromCharCode(0);

/** The words of passage text, and whether its HTML nests too deeply to read (see `countWhitespaceWords`). */
export interface WordCount {
  readonly words: number;
  /** The `'whitespace'` method could not read the HTML, so the words of its text without tags were counted. */
  readonly htmlTooDeep: boolean;
}

/**
 * The words of passage text that a reader sees, as SugarCube shows it: the text `readMarkup` leaves, read as HTML
 * (`htmlText`), split at white space. When its elements nest more than `MAX_HTML_DEPTH` deep, which a passage that
 * opens an element in each branch of an `<<if>>` can do without nesting at all when shown, the words of the text
 * without tags are counted instead.
 */
function countWhitespaceWords(text: string): WordCount {
  const { html, prose, htmlTooDeep } = readMarkup(text);
  if (htmlTooDeep) return { words: splitTweeFields(prose).length, htmlTooDeep };
  // Text that holds no tag, character reference or NUL reads as itself.
  if (!html.includes('<') && !html.includes('&') && !html.includes(NUL)) {
    return { words: splitTweeFields(html).length, htmlTooDeep: false };
  }
  try {
    // SugarCube makes the elements of passage markup one by one, so those inside `<math>` are HTML elements.
    return { words: splitTweeFields(htmlText(html, { mathText: false })).length, htmlTooDeep: false };
  } catch (e) {
    if (!(e instanceof HtmlNestingError)) throw e;
    return { words: splitTweeFields(prose).length, htmlTooDeep: true };
  }
}

/**
 * Count the words of passage text.
 *
 * - `'tweego'` (default), as Tweego counts them: line feeds and comments are removed, the rest is decomposed
 *   (NFKD) and its normalization segments counted (a letter with its accents is one), and every five, or
 *   part of five, make a word.
 * - `'whitespace'`: the words a reader sees when SugarCube shows the passage (see `countWhitespaceWords`): macro
 *   tags, comments and tags give none, link markup gives the text it shows, a `<` that starts no tag is text, and
 *   character references give their characters. The runs of non-white-space characters are counted.
 */
export function countTextWordsChecked(text: string, method: WordCountMethod): WordCount {
  switch (method) {
    case 'tweego': {
      const count = countNormalizationSegments(stripComments(text.replaceAll('\n', '')));
      return { words: Math.ceil(count / 5), htmlTooDeep: false };
    }
    case 'whitespace':
      return countWhitespaceWords(text);
    default: {
      const _exhaustive: never = method;
      throw new Error(`Unhandled word count method: ${String(_exhaustive)}`);
    }
  }
}

/** The number of words in passage text (see `countTextWordsChecked`). */
export function countTextWords(text: string, method: WordCountMethod): number {
  return countTextWordsChecked(text, method).words;
}
