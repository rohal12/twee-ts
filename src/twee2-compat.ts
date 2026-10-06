/**
 * Twee2 to Twee 3 header conversion, as Tweego's twee2compat.go does it.
 *
 * Tweego uses three Go (RE2) regular expressions in multi-line mode:
 *
 * - detect: `(?m)^:: *[^\[]*?(?: *\[.*?\])? *<(.*?)> *$`
 * - header: `(?m)^(:: *[^\[]*?)( *\[.*?\])?(?: *<(.*?)>)? *$`, replaced with `${1}${2} {"position":"${3}"}`
 * - empty position: `(?m)^(::.*?) *{"position":" *"}$`, replaced with `$1`
 *
 * In Go, lines end only at LF, `.` matches anything but LF, and a negated class such as `[^\[]` matches LF
 * too. JavaScript regular expressions also end lines at CR, U+2028 and U+2029, and backtrack, which takes
 * polynomial time on long runs of spaces. So the expressions are evaluated here by hand, line by line, in
 * linear time, with the match RE2 would choose (leftmost-first, preferring the shorter lazy match). The test
 * suite checks this against JavaScript expressions written to have Go's semantics.
 */

const POSITION_OPEN = '{"position":"';
const POSITION_CLOSE = '"}';

/** Index of the last character of `s` before `end` that is not a space (U+0020), or -1. */
function lastNonSpace(s: string, end: number): number {
  let i = end - 1;
  while (i >= 0 && s.charCodeAt(i) === 0x20) i--;
  return i;
}

/**
 * Whether the detect expression has a match that ends at the end of `line`: the line, without trailing spaces,
 * ends with `>`, and an earlier `<` follows either text with no `[` or a tag block (`[…]`), each with optional
 * spaces before the `<`.
 */
function endsWithPositionBlock(line: string): boolean {
  const end = lastNonSpace(line, line.length);
  if (end < 0 || line[end] !== '>') return false;
  const firstBracket = line.indexOf('[');
  for (let lt = line.indexOf('<'); lt !== -1 && lt < end; lt = line.indexOf('<', lt + 1)) {
    if (firstBracket === -1 || firstBracket >= lt) return true;
    const before = lastNonSpace(line, lt);
    if (line[before] === ']' && before > firstBracket) return true;
  }
  return false;
}

/**
 * Whether `lines` hold Twee2 syntax, as Tweego's detect expression finds it. Its `[^\[]*?` crosses line
 * breaks, so the `<…>` block may end a later line than the header's, as long as no `[` comes between the
 * header's `::` and that line.
 */
function hasTwee2Syntax(lines: readonly string[]): boolean {
  let open = false;
  for (const line of lines) {
    const header = line.startsWith('::');
    if ((open || header) && endsWithPositionBlock(line)) return true;
    open = header ? !line.slice(2).includes('[') : open && !line.includes('[');
  }
  return false;
}

/** What the header expression captures: `head` (group 1), `tags` (group 2) and `position` (group 3). */
interface HeaderMatch {
  readonly head: string;
  readonly tags: string;
  readonly position: string;
}

/**
 * The header expression's match for a line that starts with `::`, or undefined when it has none. The rest of
 * the line after `::` is split into a name part with no `[` (as short as possible), an optional tag block and
 * an optional `<…>` block, with only spaces after them.
 */
function matchHeader(line: string): HeaderMatch | undefined {
  const rest = line.slice(2);
  const end = lastNonSpace(rest, rest.length);
  // The position block when its `<` is at `lt` (the first character after the spaces that may precede it):
  // the line then ends with `>` and spaces.
  const positionAt = (lt: number): string | undefined =>
    rest[lt] === '<' && lt < end && rest[end] === '>' ? rest.slice(lt + 1, end) : undefined;
  const match = (nameEnd: number, tagsEnd: number, position: string | undefined): HeaderMatch => ({
    head: '::' + rest.slice(0, nameEnd),
    tags: rest.slice(nameEnd, tagsEnd),
    position: position ?? '',
  });

  // The greedy ` *` after `::` takes the leading spaces into group 1 first; a match is always found with all
  // of them taken, if there is one at all, so the name part starts after them.
  let leading = 0;
  while (rest.charCodeAt(leading) === 0x20) leading++;
  const bracket = rest.indexOf('[');
  const nameLimit = bracket === -1 ? rest.length : bracket;
  // A tag block can start only after the run of spaces just before the first `[`.
  const tagsFrom = bracket === -1 ? -1 : Math.max(leading, lastNonSpace(rest, bracket) + 1);
  // The first character at or after `nameEnd` that is not a space; it only moves forward, so the loop is linear.
  let next = leading;
  for (let nameEnd = leading; nameEnd <= nameLimit; nameEnd++) {
    if (nameEnd === tagsFrom) {
      const tagged = matchTagBlock(rest, bracket, end, positionAt);
      if (tagged !== undefined) return match(nameEnd, tagged.tagsEnd, tagged.position);
    }
    next = Math.max(next, nameEnd);
    while (rest.charCodeAt(next) === 0x20) next++;
    // No tag block: a position block, or nothing but spaces.
    const position = positionAt(next);
    if (position !== undefined) return match(nameEnd, nameEnd, position);
    if (nameEnd > end) return match(nameEnd, nameEnd, undefined);
  }
  return undefined;
}

/**
 * The tag block that starts at the `[` at `bracket`: it ends at the first `]` after which the line holds only
 * a position block or only spaces. The spaces skipped after each `]` end at the next `]` at the latest, so
 * the search is linear.
 */
function matchTagBlock(
  rest: string,
  bracket: number,
  end: number,
  positionAt: (lt: number) => string | undefined,
): { readonly tagsEnd: number; readonly position: string | undefined } | undefined {
  for (let close = rest.indexOf(']', bracket + 1); close !== -1; close = rest.indexOf(']', close + 1)) {
    let lt = close + 1;
    while (rest.charCodeAt(lt) === 0x20) lt++;
    const position = positionAt(lt);
    if (position !== undefined || close === end) return { tagsEnd: close + 1, position };
  }
  return undefined;
}

/** A line with an empty or all-space position block at its end removed, with the spaces before it. */
function withoutEmptyPosition(line: string): string {
  if (!line.startsWith('::') || !line.endsWith(POSITION_CLOSE)) return line;
  const spacesFrom = lastNonSpace(line, line.length - POSITION_CLOSE.length) + 1;
  const open = spacesFrom - POSITION_OPEN.length;
  if (open < 2 || line.slice(open, spacesFrom) !== POSITION_OPEN) return line;
  // The line starts with `::`, so at least that is kept.
  return line.slice(0, lastNonSpace(line, open) + 1);
}

/**
 * Convert Twee2 position blocks `<x,y>` in passage headers to Twee 3 metadata blocks `{"position":"x,y"}`,
 * exactly as Tweego does. Source text with no Twee2 syntax is returned unchanged.
 */
export function twee2ToV3(s: string): string {
  const lines = s.split('\n');
  if (!hasTwee2Syntax(lines)) return s;
  return lines
    .map((line) => {
      if (!line.startsWith('::')) return line;
      const m = matchHeader(line);
      const converted = m === undefined ? line : `${m.head}${m.tags} {"position":"${m.position}"}`;
      return withoutEmptyPosition(converted);
    })
    .join('\n');
}
