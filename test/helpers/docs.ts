/**
 * Reads the documentation (README.md and docs/**.md) for the documentation tests: the fenced code
 * blocks with the `docs-test` directive written before each, and the tables.
 *
 * A directive is an HTML comment on the line before a block (blank lines between are allowed):
 *
 *   <!-- docs-test: no-run — downloads from the network -->
 *
 * It holds words (`no-run`, `skip`, `mirror`, …), `key=value` pairs (`exit=1`, `fixture=broken`,
 * `from=@rohal12/twee-ts/vite`) and, after an em dash, the reason. Markdown renderers (VitePress,
 * GitHub) do not show HTML comments, so readers never see directives.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const REPO = join(__dirname, '..', '..');

/** A directive: its words, its key=value pairs and its reason. */
interface Directive {
  readonly words: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly reason: string;
}

export interface CodeBlock {
  /** The document, relative to the repository root, with forward slashes. */
  readonly doc: string;
  /** The line of the opening fence (1-based). */
  readonly line: number;
  /** The info string's language, lower case (`typescript`, `sh`, ``). */
  readonly lang: string;
  readonly code: string;
  readonly directive: Directive;
  /** The heading the block is under, for messages. */
  readonly heading: string;
}

const EMPTY_DIRECTIVE: Directive = { words: new Set(), values: new Map(), reason: '' };

const DIRECTIVE_RE = /^<!--\s*docs-test:\s*(.*?)\s*-->$/;
const PRETTIER_IGNORE = '<!-- prettier-ignore -->';

function parseDirective(text: string): Directive {
  const [spec = '', ...reason] = text.split(' — ');
  const words = new Set<string>();
  const values = new Map<string, string>();
  for (const token of spec.split(/\s+/).filter((t) => t !== '')) {
    const eq = token.indexOf('=');
    if (eq === -1) words.add(token);
    else values.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return { words, values, reason: reason.join(' — ').trim() };
}

/** Every Markdown document the tests read: README.md and docs/**.md, without VitePress's own folder. */
export function documentFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : [],
      );
  return [join(REPO, 'README.md'), ...walk(join(REPO, 'docs'))].sort();
}

export function docName(file: string): string {
  return relative(REPO, file).replace(/\\/g, '/');
}

/** The fenced code blocks of one document. */
export function codeBlocks(file: string, text = readFileSync(file, 'utf8')): CodeBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: CodeBlock[] = [];
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch?.[1] !== undefined) heading = headingMatch[1];
    const open = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (open === null) continue;
    const fence = open[2] ?? '```';
    const indent = open[1] ?? '';
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !(lines[j] ?? '').trimStart().startsWith(fence)) {
      body.push((lines[j] ?? '').startsWith(indent) ? (lines[j] ?? '').slice(indent.length) : (lines[j] ?? ''));
      j++;
    }
    // The directive: the nearest line before the fence that is neither blank nor Prettier's
    // `<!-- prettier-ignore -->` (which must come right before the block it keeps as written).
    let k = i - 1;
    while (k >= 0 && ['', PRETTIER_IGNORE].includes((lines[k] ?? '').trim())) k--;
    const directiveMatch = DIRECTIVE_RE.exec((lines[k] ?? '').trim());
    blocks.push({
      doc: docName(file),
      line: i + 1,
      lang: (open[3] ?? '').toLowerCase(),
      code: body.join('\n'),
      directive: directiveMatch?.[1] === undefined ? EMPTY_DIRECTIVE : parseDirective(directiveMatch[1]),
      heading,
    });
    i = j;
  }
  return blocks;
}

/** Every code block of every document. */
export function allCodeBlocks(): CodeBlock[] {
  return documentFiles().flatMap((file) => codeBlocks(file));
}

export function blockId(block: CodeBlock): string {
  return `${block.doc}:${block.line}`;
}

/** A Markdown table: its header cells and rows of cells, with the heading it is under. */
export interface Table {
  readonly heading: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** The tables of a document, outside code blocks. */
export function tables(text: string): Table[] {
  const lines = text.split(/\r?\n/);
  const found: Table[] = [];
  let heading = '';
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch?.[1] !== undefined) heading = headingMatch[1];
    if (!line.trimStart().startsWith('|') || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue;
    const header = cells(line);
    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && (lines[j] ?? '').trimStart().startsWith('|')) {
      rows.push(cells(lines[j] ?? ''));
      j++;
    }
    found.push({ heading, header, rows });
    i = j - 1;
  }
  return found;
}

/** The text of the inline code spans in a Markdown cell (`` `--output <file>` `` gives `--output <file>`). */
export function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

/**
 * Splits a shell command line into words as a POSIX shell would for the simple commands the docs
 * use: single and double quotes, backslash escapes, and `#` comments. Anything a simple command
 * can't hold (pipes, redirections, `&&`, substitutions) is an error, so the test can't run a
 * command other than the one the docs show.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  // Whether a word has started: `''` is an empty word, which an unquoted gap is not.
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && i + 1 < line.length) word += line.charAt(++i);
      else if (c === '$' || c === '`') throw new Error(`unsupported substitution in: ${line}`);
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line.charAt(++i);
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (c === '#' && !inWord) {
      break;
    } else if ('|&;<>()$`'.includes(c)) {
      throw new Error(`not a simple command (${c}): ${line}`);
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== undefined) throw new Error(`unterminated quote in: ${line}`);
  if (inWord) words.push(word);
  return words;
}
