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

/** Characters a reading may still look at: it stops, as having failed, when they run out. */
interface Reader {
  readonly text: string;
  readonly limit: number;
}

/**
 * Reads link or image markup that starts at `start` in `text`, or returns `undefined` where
 * SugarCube rejects it (and so prints the text instead).
 *
 * `budget.left`, if given, is how many characters the reading may look at; it is reduced by as
 * many as were read, and once it runs out, every reading fails. Unclosed markup is read to the end
 * of its line, so reading every `[[` of a long line that never closes one would otherwise take
 * quadratic time.
 */
export function readSquareBracketedMarkup(
  text: string,
  start: number,
  budget: { left: number } = { left: Infinity },
): SquareBracketedMarkup | undefined {
  const reader: Reader = { text, limit: Math.min(text.length, start + Math.max(budget.left, 0)) };
  const markup = readMarkup(reader, start);
  budget.left -= (markup?.end ?? reader.limit) - start;
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
      return { type, link: linkName(core.link), end: setterEnd };
    }
    return { type, link: linkName(core.link), end: core.end.next };
  }
  if (core.end.last) {
    return { type, link: undefined, end: core.end.next };
  }
  // An image's link component, then perhaps a setter.
  const linkEnd = readComponent(reader, core.end.next, false);
  if (linkEnd === undefined) {
    return undefined;
  }
  const link = linkName(text.slice(core.end.next, linkEnd.textEnd));
  if (linkEnd.last) {
    return { type, link, end: linkEnd.next };
  }
  const setterEnd = readSetter(reader, linkEnd.next);
  return setterEnd === undefined ? undefined : { type, link, end: setterEnd };
}

/** The link component as SugarCube keeps it: trimmed, and without a leading `~`. */
function linkName(component: string): string {
  const trimmed = component.trim();
  return trimmed.startsWith('~') ? trimmed.slice(1) : trimmed;
}

/**
 * Reads the first components: the text and the link of link markup, or the title and the source
 * of image markup, divided by the first delimiter. `link` is the text of the link (or source)
 * component, untrimmed.
 */
function readCoreComponents(reader: Reader, from: number): { link: string; end: ComponentEnd } | undefined {
  const { text } = reader;
  let delimiter: 'none' | 'ltr' | 'rtl' = 'none';
  let componentStart = from;
  let link: string | undefined;
  let depth = 2;
  let pos = from;
  while (pos < reader.limit) {
    const ch = text[pos];
    pos += 1;
    switch (ch) {
      case '\n':
        return undefined;
      case '"': {
        const end = readQuoted(reader, pos, '"');
        if (end === undefined) {
          return undefined;
        }
        pos = end;
        break;
      }
      case '|':
        if (delimiter === 'none') {
          delimiter = 'ltr';
          componentStart = pos;
        }
        break;
      case '-':
        if (delimiter === 'none' && text[pos] === '>') {
          delimiter = 'ltr';
          pos += 1;
          componentStart = pos;
        }
        break;
      case '<':
        if (delimiter === 'none' && text[pos] === '-') {
          delimiter = 'rtl';
          link = text.slice(componentStart, pos - 1);
          pos += 1;
          componentStart = pos;
        }
        break;
      case '[':
        depth += 1;
        break;
      case ']': {
        depth -= 1;
        if (depth === 1) {
          const end = componentEnd(text, pos);
          if (end === undefined) {
            return undefined;
          }
          // With `<-`, the link came first and this component is the text.
          return { link: link ?? text.slice(componentStart, end.textEnd), end };
        }
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

/**
 * Reads a component after `][` that holds no delimiter: an image's link (`setter` false) or a
 * setter, in which single quotes also quote.
 */
function readComponent(reader: Reader, from: number, setter: boolean): ComponentEnd | undefined {
  const { text } = reader;
  let depth = 2;
  let pos = from;
  while (pos < reader.limit) {
    const ch = text[pos];
    pos += 1;
    switch (ch) {
      case '\n':
        return undefined;
      case '"':
      case "'": {
        if (ch === "'" && !setter) {
          break;
        }
        const end = readQuoted(reader, pos, ch);
        if (end === undefined) {
          return undefined;
        }
        pos = end;
        break;
      }
      case '[':
        depth += 1;
        break;
      case ']':
        depth -= 1;
        if (depth === 1) {
          return componentEnd(text, pos);
        }
        break;
      default:
        break;
    }
  }
  return undefined;
}

/** Reads a setter, the last component; returns the index after its closing `]]`. */
function readSetter(reader: Reader, from: number): number | undefined {
  const end = readComponent(reader, from, true);
  return end?.last === true ? end.next : undefined;
}

/** What the `]` just before `pos`, which brings the depth back to one, ends; `undefined` if malformed. */
function componentEnd(text: string, pos: number): ComponentEnd | undefined {
  switch (text[pos]) {
    case '[':
      return { textEnd: pos - 1, next: pos + 1, last: false };
    case ']':
      return { textEnd: pos - 1, next: pos + 1, last: true };
    default:
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
      return undefined;
    }
    if (ch === '\\') {
      if (pos >= reader.limit || text[pos] === '\n') {
        return undefined;
      }
      pos += 1;
    }
  }
  return undefined;
}
