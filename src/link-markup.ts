/**
 * Reads SugarCube 2 link and image markup the way SugarCube 2.37.3's
 * `Wikifier.helpers.parseSquareBracketedMarkup` does:
 *
 * - `[[Link]]`, `[[Text|Link]]`, `[[Text->Link]]` and `[[Link<-Text]]`, each with an optional
 *   setter: `[[Text|Link][$x to 1]]`;
 * - `[img[Source]]`, `[img[Title|Source]]` and `[img[Source<-Title]]`, with an optional link and
 *   setter: `[img[Source][Link][$x to 1]]`, and `[<img[` or `[>img[` for alignment.
 *
 * The first `|`, `->` or `<-` divides the text from the link; any later one is part of the link
 * or the text. Square brackets nest; a double-quoted string, or in a setter a single-quoted one
 * too, is read as a unit, so a `]` or a delimiter in it counts for nothing. The markup must end
 * on the line it starts on.
 */

/** Link or image markup, as far as finding the passage it links to needs. */
export interface SquareBracketedMarkup {
  readonly type: 'link' | 'image';
  /**
   * What the markup links to, trimmed and without the `~` that forces an internal link: a link's
   * destination, or an image's link component, if it has one. SugarCube reads it as a passage name
   * if a passage has that name, and otherwise evaluates it.
   */
  readonly link: string | undefined;
  /**
   * What a link displays, untrimmed: its text component, which is the whole of `[[Link]]`. Undefined for image
   * markup.
   */
  readonly label: string | undefined;
  /** Index just past the closing `]]`. */
  readonly end: number;
}

/** A component of the markup ends here, and the next one starts at `next`. */
interface ComponentEnd {
  /** Index just past the component's text. */
  readonly textEnd: number;
  /** Where the next part starts: after `][` or after `]]`. */
  readonly next: number;
  /** Whether `]]` ended the markup; otherwise `][` opened another component. */
  readonly last: boolean;
}

/**
 * Characters a reading may still look at: it stops, as having failed, when they run out.
 * `scanned` is how far it has looked so far: the index just past the last character it read.
 */
interface Reader {
  readonly text: string;
  readonly limit: number;
  scanned: number;
}

/** Records that the reading has looked at the characters before `pos`, and returns `result`. */
function readTo<T>(reader: Reader, pos: number, result: T): T {
  markScanned(reader, pos);
  return result;
}

/** Records that the reading looked at the characters before `pos`. */
function markScanned(reader: Reader, pos: number): void {
  reader.scanned = Math.max(reader.scanned, pos);
}

/**
 * Reads link or image markup that starts at `start` in `text`, or returns `undefined` where
 * SugarCube rejects it (and so prints the text instead).
 *
 * `budget.left`, if given, is how many characters the reading may look at; it is reduced by as
 * many as were read, and once it runs out, every reading fails. Unclosed markup is read to the end
 * of its line, so reading every `[[` of a long line that never closes one would otherwise take
 * quadratic time. A reading is charged for the characters it looked at, up to where it ended or
 * failed (a line feed, say), and no more, so markup left unclosed on short lines costs little.
 */
export function readSquareBracketedMarkup(
  text: string,
  start: number,
  budget: { left: number } = { left: Infinity },
): SquareBracketedMarkup | undefined {
  const reader: Reader = { text, limit: Math.min(text.length, start + Math.max(budget.left, 0)), scanned: start };
  const markup = readMarkup(reader, start);
  budget.left -= Math.max(reader.scanned, markup?.end ?? start) - start;
  return markup;
}

function readMarkup(reader: Reader, start: number): SquareBracketedMarkup | undefined {
  const { text } = reader;
  if (text[start] !== '[') {
    return undefined;
  }
  let pos = start + 1;
  let type: SquareBracketedMarkup['type'];
  if (text[pos] === '[') {
    type = 'link';
    pos += 1;
  } else {
    if (text[pos] === '<' || text[pos] === '>') {
      pos += 1;
    }
    if (!/^[Ii][Mm][Gg]\[/.test(text.slice(pos, pos + 4))) {
      return undefined;
    }
    type = 'image';
    pos += 4;
  }

  const core = readCoreComponents(reader, pos);
  if (core === undefined) {
    return undefined;
  }
  if (type === 'link') {
    if (!core.end.last) {
      const setterEnd = readSetter(reader, core.end.next);
      if (setterEnd === undefined) {
        return undefined;
      }
      return { type, link: linkName(core.link), label: core.label, end: setterEnd };
    }
    return { type, link: linkName(core.link), label: core.label, end: core.end.next };
  }
  if (core.end.last) {
    return { type, link: undefined, label: undefined, end: core.end.next };
  }
  // An image's link component, then perhaps a setter.
  const linkEnd = readComponent(reader, core.end.next, false);
  if (linkEnd === undefined) {
    return undefined;
  }
  const link = linkName(text.slice(core.end.next, linkEnd.textEnd));
  if (linkEnd.last) {
    return { type, link, label: undefined, end: linkEnd.next };
  }
  const setterEnd = readSetter(reader, linkEnd.next);
  return setterEnd === undefined ? undefined : { type, link, label: undefined, end: setterEnd };
}

/** The link component as SugarCube keeps it: trimmed, and without a leading `~`. */
function linkName(component: string): string {
  const trimmed = component.trim();
  return trimmed.startsWith('~') ? trimmed.slice(1) : trimmed;
}

/**
 * Reads the first components: the text and the link of link markup, or the title and the source
 * of image markup, divided by the first delimiter. `link` is the text of the link (or source)
 * component, untrimmed; `label` is the text (or title) component, untrimmed.
 */
function readCoreComponents(
  reader: Reader,
  from: number,
): { link: string; label: string; end: ComponentEnd } | undefined {
  const { text } = reader;
  const split: {
    delimiter: 'none' | 'ltr' | 'rtl';
    componentStart: number;
    labelEnd: number | undefined;
    link: string | undefined;
  } = { delimiter: 'none', componentStart: from, labelEnd: undefined, link: undefined };
  const end = scanComponent(reader, from, '"', (ch, pos) => {
    if (split.delimiter !== 'none') {
      return pos;
    }
    if (ch === '|') {
      split.delimiter = 'ltr';
      split.labelEnd = pos - 1;
      split.componentStart = pos;
    } else if (ch === '-' && text[pos] === '>') {
      split.delimiter = 'ltr';
      split.labelEnd = pos - 1;
      split.componentStart = pos + 1;
    } else if (ch === '<' && text[pos] === '-') {
      split.delimiter = 'rtl';
      split.link = text.slice(split.componentStart, pos - 1);
      split.componentStart = pos + 1;
    }
    return Math.max(pos, split.componentStart);
  });
  // With `<-`, the link came first and this component is the text.
  if (end === undefined) return undefined;
  const rest = text.slice(split.componentStart, end.textEnd);
  return { link: split.link ?? rest, label: split.delimiter === 'ltr' ? text.slice(from, split.labelEnd) : rest, end };
}

/**
 * Reads a component after `][` that holds no delimiter: an image's link (`setter` false) or a
 * setter, in which single quotes also quote.
 */
function readComponent(reader: Reader, from: number, setter: boolean): ComponentEnd | undefined {
  return scanComponent(reader, from, setter ? `"'` : '"', (_ch, pos) => pos);
}

/**
 * Reads a component from `from` to the `]` that brings the bracket depth back to one: square
 * brackets nest, a string in one of `quotes` is read as a unit, and a line feed ends the markup
 * unread. Any other character is passed to `onOther`, which returns where reading goes on.
 */
function scanComponent(
  reader: Reader,
  from: number,
  quotes: string,
  onOther: (ch: string, pos: number) => number,
): ComponentEnd | undefined {
  const { text } = reader;
  let depth = 2;
  let pos = from;
  while (pos < reader.limit) {
    const ch = text.charAt(pos);
    pos += 1;
    if (ch === '\n') {
      markScanned(reader, pos);
      return undefined;
    }
    if (quotes.includes(ch)) {
      const end = readQuoted(reader, pos, ch);
      if (end === undefined) {
        return undefined;
      }
      pos = end;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 1) {
        return componentEnd(reader, pos);
      }
    } else {
      pos = onOther(ch, pos);
    }
  }
  markScanned(reader, pos);
  return undefined;
}

/** Reads a setter, the last component; returns the index after its closing `]]`. */
function readSetter(reader: Reader, from: number): number | undefined {
  const end = readComponent(reader, from, true);
  return end?.last === true ? end.next : undefined;
}

/** What the `]` just before `pos`, which brings the depth back to one, ends; `undefined` if malformed. */
function componentEnd(reader: Reader, pos: number): ComponentEnd | undefined {
  // Whatever it holds, the character at `pos` has been looked at.
  switch (reader.text[pos]) {
    case '[':
      return readTo(reader, pos + 1, { textEnd: pos - 1, next: pos + 1, last: false });
    case ']':
      return readTo(reader, pos + 1, { textEnd: pos - 1, next: pos + 1, last: true });
    default:
      markScanned(reader, pos + 1);
      return undefined;
  }
}

/**
 * Reads a quoted string from just after its opening quote; a backslash escapes the character
 * after it. A line feed, or the end of the text, ends it unterminated. Returns the index after the
 * closing quote.
 */
function readQuoted(reader: Reader, from: number, quote: string): number | undefined {
  const { text } = reader;
  let pos = from;
  while (pos < reader.limit) {
    const ch = text[pos];
    pos += 1;
    if (ch === quote) {
      return pos;
    }
    if (ch === '\n') {
      markScanned(reader, pos);
      return undefined;
    }
    if (ch === '\\') {
      if (pos >= reader.limit || text[pos] === '\n') {
        markScanned(reader, Math.min(pos + 1, reader.limit));
        return undefined;
      }
      pos += 1;
    }
  }
  markScanned(reader, pos);
  return undefined;
}
