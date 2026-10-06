/**
 * Where things are in an HTML document, as a browser's HTML parser sees them.
 *
 * Every structural location twee-ts needs in HTML is read here from a parse by parse5 (bundled), through its public
 * API with source locations, and never by matching markup text: the end and start of the head (for modules, the head
 * file and the Vite client), the Twine 1 store area (for the IFID comment), the context of each placeholder in a
 * story format template (for escaping), and the story data of compiled HTML (for the decompiler).
 *
 * Supported subset: any input, read as the WHATWG HTML parser reads it with scripting enabled (as story formats run),
 * which is how parse5 reads it. Content inserted into the head becomes HTML-namespace children of the head element
 * (never text, a comment, an attribute value, template content or CDATA); where no such point exists, nothing is
 * inserted and the caller reports it.
 */
import { parse, html as htmlSpec } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { cssContexts, javaScriptContexts } from './code-context.js';
import type { InContext, SourceRange } from './code-context.js';
import { attrEscape } from './escape.js';
import type { InsertionContext } from './escape.js';

type HtmlDocument = DefaultTreeAdapterTypes.Document;
/** An element of a parsed document. */
export type HtmlElement = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlNode = DefaultTreeAdapterTypes.Node;

const HTML_NS = htmlSpec.NS.HTML;

/**
 * Parse a whole document as a browser does with scripting enabled, with the source location of every node unless
 * `locations` is false. parse5 preprocesses the input stream as the HTML standard does (CRLF and CR become LF; NUL
 * is dropped from text and becomes U+FFFD elsewhere); source locations are offsets into `html` as given.
 */
export function parseHtml(html: string, locations = true): HtmlDocument {
  return parse(html, { sourceCodeLocationInfo: locations, scriptingEnabled: true });
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

function isHtmlElement(node: HtmlNode, tagName: string): node is HtmlElement {
  return isElement(node) && node.tagName === tagName && node.namespaceURI === HTML_NS;
}

function childrenOf(node: HtmlNode): readonly ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

/** The content of a `template` element (in any namespace parse5 gives one), or `undefined`. */
function templateContent(node: HtmlNode): ParentNode | undefined {
  return 'content' in node ? node.content : undefined;
}

/** A node of a tree walk, and whether it lies inside the content of a template element. */
interface Visit {
  readonly node: ChildNode;
  readonly inTemplate: boolean;
}

/**
 * The nodes under `root` in tree order (an iterative walk, so deep documents don't overflow the stack). Template
 * contents are walked too when `intoTemplates`, after the template's children; a browser's `textContent`,
 * `getElementById` and `querySelector` don't look into them.
 */
function* descendants(root: HtmlNode, intoTemplates: boolean): Generator<Visit> {
  const stack: Visit[] = [...childrenOf(root)].reverse().map((node) => ({ node, inTemplate: false }));
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    yield visit;
    const { node, inTemplate } = visit;
    const content = intoTemplates ? templateContent(node) : undefined;
    if (content !== undefined) {
      for (const child of [...content.childNodes].reverse()) stack.push({ node: child, inTemplate: true });
    }
    for (const child of [...childrenOf(node)].reverse()) stack.push({ node: child, inTemplate });
  }
}

/** The first element in tree order, outside template contents, that `matches`; as `querySelector()` finds it. */
function findElement(doc: HtmlDocument, matches: (element: HtmlElement) => boolean): HtmlElement | undefined {
  for (const { node } of descendants(doc, false)) {
    if (isElement(node) && matches(node)) return node;
  }
  return undefined;
}

/** The value of an element's attribute (in no namespace), or `undefined`. */
export function attributeOf(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name && attr.namespace === undefined)?.value;
}

/** The text of an element as the DOM's `textContent` gives it: all its descendant text, outside template contents. */
export function textContent(element: HtmlElement): string {
  let text = '';
  for (const { node } of descendants(element, false)) {
    if (node.nodeName === '#text' && 'value' in node) text += node.value;
  }
  return text;
}

/** The children of an element that are elements, outside template contents. */
export function childElements(element: HtmlElement): readonly HtmlElement[] {
  return element.childNodes.filter(isElement);
}

/** The Twine 2 story data: the first `tw-storydata` element, in any namespace, as `querySelector()` finds it. */
export function findStoryData(doc: HtmlDocument): HtmlElement | undefined {
  return findElement(doc, (element) => element.tagName === 'tw-storydata');
}

/** What names the Twine 1 store area in diagnostics. */
export const STORE_AREA_DESCRIPTION = 'element with the id "store-area" or "storeArea"';

/** The ids of the Twine 1 store area: SugarCube's, then that of the Twine 1.4 story formats. */
const STORE_AREA_IDS: readonly [string, string] = ['store-area', 'storeArea'];

/**
 * The Twine 1 store area, as a story format's `getElementById()` finds it: the first element with the id
 * `store-area` or `storeArea`, or with `prefer`, the first `store-area` element if there is one (as Tweego picks the
 * one for the IFID comment).
 */
export function findStoreArea(doc: HtmlDocument, prefer = false): HtmlElement | undefined {
  const isStoreArea = (id: string | undefined): boolean => STORE_AREA_IDS.some((storeId) => storeId === id);
  if (prefer) {
    const first = findElement(doc, (element) => attributeOf(element, 'id') === STORE_AREA_IDS[0]);
    if (first !== undefined) return first;
  }
  return findElement(doc, (element) => isStoreArea(attributeOf(element, 'id')));
}

/** The Twine 1 archive: the store area holding `count` tiddlers, `data`. */
export function twine1ArchiveStoreArea(count: number, data: string): string {
  return `<div id="${STORE_AREA_IDS[1]}" data-size="${count}">${data}</div>\n`;
}

/**
 * An element the HTML parser reads as it reads story data: a `tw-storydata` element (Twine 2) or a tiddler `div`
 * (Twine 1), holding text when `hasText` says the story data holds passage text that is not whitespace (text in the
 * body keeps a later `frameset` start tag from replacing the body, as such passage text does).
 */
export function storyDataProbe(format: 'twine2' | 'twine1', hasText: boolean): string {
  const text = hasText ? 'x' : '';
  return format === 'twine2' ? `<tw-storydata hidden>${text}</tw-storydata>` : `<div tiddler="">${text}</div>`;
}

/** What follows the story data of a pre-1.4 Twine 1 format that has no footer file (as Tweego writes it). */
export const DEFAULT_TWINE1_FOOTER = '</div>\n</body>\n</html>\n';

/** The head element of a document: the `head` child of the root `html` element. */
function documentHead(doc: HtmlDocument): HtmlElement | undefined {
  const root = doc.childNodes.find((node) => isHtmlElement(node, 'html'));
  return root === undefined ? undefined : root.childNodes.find((node) => isHtmlElement(node, 'head'));
}

/**
 * A canonical serialization of the document tree, with the nodes that start in `[from, to)` left out: elements with
 * their namespace and attributes, text, comments, the doctype, template contents, and the document mode. Two
 * documents with the same key build the same DOM, so inserting `[from, to)` changed nothing else when the key of the
 * document with it equals the key of the document without it.
 */
function structureKey(
  doc: HtmlDocument,
  from = 0,
  to = 0,
  editText: (text: string) => string = (text) => text,
): string {
  const parts: string[] = [doc.mode];
  // Adjacent text nodes on either side of an insertion merge or split; their text is what counts.
  let text: string | undefined;
  const flushText = (): void => {
    if (text !== undefined && text !== '') parts.push(`#text${JSON.stringify(text)}`);
    text = undefined;
  };
  const inserted = (node: ChildNode): boolean => {
    const start = node.sourceCodeLocation?.startOffset;
    return start !== undefined && start >= from && start < to;
  };
  const write = (node: ParentNode): void => {
    for (const child of node.childNodes) {
      if (inserted(child)) continue;
      if ('value' in child) {
        text = (text ?? '') + editText(child.value);
        continue;
      }
      flushText();
      if (isElement(child)) {
        parts.push(`<${child.namespaceURI} ${child.tagName}${JSON.stringify(child.attrs)}>`);
        write(child);
        const content = templateContent(child);
        if (content !== undefined) {
          parts.push('<#content>');
          write(content);
          flushText();
          parts.push('</#content>');
        }
        flushText();
        parts.push('</>');
      } else if ('data' in child) {
        parts.push(`#comment${JSON.stringify(child.data)}`);
      } else {
        parts.push(`#doctype${JSON.stringify([child.name, child.publicId, child.systemId])}`);
      }
    }
  };
  write(doc);
  flushText();
  return parts.join('\n');
}

/**
 * Whether replacing `[start, end)` of `html` (parsed as `doc`) with the element `probe` makes the probe an element of
 * the live document (in the HTML namespace, outside template contents) and changes nothing else: so that markup like
 * the probe written there becomes elements of the page. `[start, end)` lies in text.
 */
export function replacementIsLiveElement(
  html: string,
  doc: HtmlDocument,
  start: number,
  end: number,
  probe: string,
): boolean {
  const removed = html.slice(start, end);
  const before = structureKey(doc, 0, 0, (text) => text.replace(removed, ''));
  const after = parseHtml(html.slice(0, start) + probe + html.slice(end));
  const found = [...descendants(after, true)].find(({ node }) => node.sourceCodeLocation?.startOffset === start);
  const live = found !== undefined && !found.inTemplate && isElement(found.node) && found.node.namespaceURI === HTML_NS;
  return live && structureKey(after, start, start + probe.length) === before;
}

/** Insert `text` into `html` at `offset`. */
function insertAt(html: string, offset: number, text: string): string {
  return html.slice(0, offset) + text + html.slice(offset);
}

/**
 * Whether inserting `text` at `offset` in `html` (parsed as `doc`, with structure key `key`) adds nodes to the
 * document's head only: every node parsed from `text` is in the head, and everything else builds as before.
 */
function insertsIntoHead(html: string, key: string, offset: number, text: string): boolean {
  const after = parseHtml(insertAt(html, offset, text));
  const end = offset + text.length;
  if (structureKey(after, offset, end) !== key) return false;
  const head = documentHead(after);
  const isInserted = (start: number | undefined): boolean => start !== undefined && start >= offset && start < end;
  const inserted = [...descendants(after, true)].filter(({ node }) => isInserted(node.sourceCodeLocation?.startOffset));
  // Something must be there: the parser drops content that a frameset replaces, for one.
  return (
    inserted.length > 0 &&
    inserted.every(({ node }) => {
      const parent = node.parentNode;
      return parent === head || isInserted(parent?.sourceCodeLocation?.startOffset);
    })
  );
}

/** A probe element, inserted to check that a place puts elements into the head. */
const PROBE = '<script></script>';

/** Where content goes into a document's head, and how that place was found. */
export interface HeadPlacement {
  readonly offset: number;
  /**
   * `end-tag`: before the closing head tag that ends the head. `implicit-end`: where the head ends without one (at
   * the tag or text that implies the end, or at the end of the document). `start-tag`: after the head start tag.
   * `implied-start`: where the parser creates the head with no head start tag.
   */
  readonly how: 'end-tag' | 'implicit-end' | 'start-tag' | 'implied-start';
}

/** Offsets, in order of preference, where an insertion may put elements at the end of the head. */
function headEndCandidates(doc: HtmlDocument, head: HtmlElement): number[] {
  const candidates: number[] = [];
  const location = head.sourceCodeLocation;
  if (location !== undefined && location !== null) candidates.push(location.endOffset);
  const lastChildEnd = head.childNodes.reduce<number | undefined>(
    (end, child) => child.sourceCodeLocation?.endOffset ?? end,
    undefined,
  );
  if (lastChildEnd !== undefined) candidates.push(lastChildEnd);
  candidates.push(...headStartCandidates(doc));
  return candidates;
}

/** Offsets, in order of preference, where an insertion may put elements at the start of an implied head. */
function headStartCandidates(doc: HtmlDocument): number[] {
  const candidates: number[] = [];
  const root = doc.childNodes.find((node) => isHtmlElement(node, 'html'));
  const rootStart = root?.sourceCodeLocation?.startTag?.endOffset;
  if (rootStart !== undefined) candidates.push(rootStart);
  const doctypeEnd = doc.childNodes.find((node) => node.nodeName === '#documentType')?.sourceCodeLocation?.endOffset;
  if (doctypeEnd !== undefined) candidates.push(doctypeEnd);
  // Before the first node that the document element holds, after any leading doctype and comments.
  if (root !== undefined) {
    for (const { node } of descendants(root, false)) {
      const start = node.sourceCodeLocation?.startOffset;
      if (start !== undefined) {
        candidates.push(start);
        break;
      }
    }
  }
  candidates.push(0);
  return [...new Set(candidates)];
}

/**
 * Where content goes to come last in the head of `html`: before the closing head tag that ends the head (as Tweego
 * places it); without one, where the head ends implicitly; with no head start tag either, where the parser creates
 * the head. Each place but the first is checked by parsing the document with a probe element there. `undefined` when
 * no place puts elements into the head.
 */
export function locateHeadEnd(html: string, doc: HtmlDocument = parseHtml(html)): HeadPlacement | undefined {
  const head = documentHead(doc);
  if (head === undefined) return undefined;
  const endTag = head.sourceCodeLocation?.endTag;
  if (endTag !== undefined) return { offset: endTag.startOffset, how: 'end-tag' };
  const key = structureKey(doc);
  const how = head.sourceCodeLocation ? 'implicit-end' : 'implied-start';
  const offset = headEndCandidates(doc, head).find((candidate) => insertsIntoHead(html, key, candidate, PROBE));
  return offset === undefined ? undefined : { offset, how };
}

/**
 * Where content goes to come first in the head of `html`: after the head start tag; without one, where the parser
 * creates the head (after the html start tag, after the doctype, or before the first node), checked by parsing the
 * document with `probe` there. `undefined` when no place puts elements into the head.
 *
 * A head start tag found in a parse of a prefix of the document is the one a parse of the whole document finds: the
 * parser reads left to right and never changes what it built for earlier tokens. So a long document whose head
 * starts early is parsed only up to there.
 */
export function locateHeadStart(html: string, probe: string = PROBE): HeadPlacement | undefined {
  const prefixLength = Math.min(html.length, HEAD_START_PREFIX);
  const startTag = documentHead(parseHtml(html.slice(0, prefixLength)))?.sourceCodeLocation?.startTag;
  if (startTag !== undefined) return { offset: startTag.endOffset, how: 'start-tag' };
  if (prefixLength === html.length) return locateImpliedHeadStart(html, parseHtml(html), probe);
  const doc = parseHtml(html);
  const fullStartTag = documentHead(doc)?.sourceCodeLocation?.startTag;
  if (fullStartTag !== undefined) return { offset: fullStartTag.endOffset, how: 'start-tag' };
  return locateImpliedHeadStart(html, doc, probe);
}

/** How much of a document `locateHeadStart()` parses first. */
const HEAD_START_PREFIX = 65536;

function locateImpliedHeadStart(html: string, doc: HtmlDocument, probe: string): HeadPlacement | undefined {
  const key = structureKey(doc);
  const offset = headStartCandidates(doc).find((candidate) => insertsIntoHead(html, key, candidate, probe));
  return offset === undefined ? undefined : { offset, how: 'implied-start' };
}

/**
 * Whether inserting `content` at `offset` in `html` keeps the rest of the document as it was and puts all of
 * `content` into the head. Content that is not (such as an unclosed comment or element, text, or body elements)
 * changes where the document's own nodes go.
 */
export function contentStaysInHead(html: string, doc: HtmlDocument, offset: number, content: string): boolean {
  return insertsIntoHead(html, structureKey(doc), offset, content);
}

/** The start tag offsets of the Twine 1 store area element, preferring `store-area` as Tweego does. */
export function locateStoreArea(doc: HtmlDocument): number | undefined {
  return findStoreArea(doc, true)?.sourceCodeLocation?.startTag?.startOffset;
}

/** The Vite client script element, for `src` (Vite's base followed by `@vite/client`). */
function viteClientTag(src: string): string {
  return `<script type="module" src="${attrEscape(src)}"></script>`;
}

/**
 * Add Vite's client script to `html` as the first element of its head (see `locateHeadStart()`). A document with no
 * place that leaves the rest of it as it was (one that is all an unclosed comment) still gets the client, after its
 * doctype (so it keeps its mode), where a comment that follows moves into the head.
 */
export function insertViteClient(html: string, src: string): string {
  const tag = viteClientTag(src);
  const placement = locateHeadStart(html, tag);
  const doctypeEnd = (): number | undefined =>
    parseHtml(html).childNodes.find((node) => node.nodeName === '#documentType')?.sourceCodeLocation?.endOffset;
  return insertAt(html, placement?.offset ?? doctypeEnd() ?? 0, tag);
}

/** The page the Vite dev server serves until the first compile succeeds, with Vite's client for `src`. */
export function viteWaitingPage(src: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    viteClientTag(src) +
    '<title>twee-ts</title></head><body><p>The story has not compiled yet.</p></body></html>'
  );
}

// --- Placeholder contexts ---

/** A placeholder in a template: the whole of it, and the part between its delimiters (`{{…}}` or `"…"`). */
export interface PlaceholderOccurrence {
  readonly start: number;
  readonly end: number;
  readonly innerStart: number;
  readonly innerEnd: number;
}

/** Where a placeholder sits, as parse5 reports it. */
export interface PlaceholderSite {
  readonly context: InsertionContext;
  /**
   * How the placeholder's delimiters are read: `inside` when they are part of the same text, comment or attribute
   * value as the name (`{{STORY_NAME}}` in a title); `attribute` when the placeholder is a whole quoted attribute
   * value (`data-size="STORY_SIZE"`); `string` when it is a whole JavaScript string literal (`"START_AT"`); `split`
   * when they are read apart from the name.
   */
  readonly delimiters: 'inside' | 'attribute' | 'string' | 'split';
}

/** The parse of a template with its placeholders, and the site of each placeholder. */
export interface TemplateAnalysis {
  /** The template with its placeholder names replaced by markers: what `doc` is the parse of, offset for offset. */
  readonly marked: string;
  readonly doc: HtmlDocument;
  readonly sites: readonly PlaceholderSite[];
}

/**
 * Parse `html` and find the site of each of `occurrences`.
 *
 * Each placeholder name is replaced, for the parse, by a marker of the same length made of private-use characters
 * that `html` doesn't contain, unique to the occurrence. A placeholder's characters (`{`, `}`, letters, `_`, and the
 * quotes kept as written) and the marker's take the same path through every tokenizer state (neither is an ASCII
 * letter after `<`, `</`, `&` or a tag name, nor whitespace, `>`, `=`, `/` or `-`), so the parse is that of the
 * template, with the same offsets; and where a marker ends up in the tree tells the placeholder's context.
 */
export function analyzeTemplate(html: string, occurrences: readonly PlaceholderOccurrence[]): TemplateAnalysis {
  const markers = makeMarkers(html, occurrences);
  let marked = html;
  for (const [i, occurrence] of occurrences.entries()) {
    marked = marked.slice(0, occurrence.innerStart) + (markers[i] ?? '') + marked.slice(occurrence.innerEnd);
  }
  const doc = parseHtml(marked);
  const found = findMarkers(doc, markers);
  const dropped: PlaceholderSite = { context: { kind: 'markup' }, delimiters: 'split' };
  const sites = occurrences.map((occurrence, i) => {
    const place = found.get(i);
    return place === undefined ? dropped : siteOf(html, place, occurrence, markers[i] ?? '');
  });
  return { marked, doc, sites: resolveCodeContexts(html, occurrences, sites, found) };
}

/** Markers for `occurrences`: a unique first character, then a filler, from private-use characters not in `html`. */
function makeMarkers(html: string, occurrences: readonly PlaceholderOccurrence[]): string[] {
  const used = new Set<number>();
  for (const match of html.matchAll(/[\uE000-\uF8FF]/g)) used.add(match[0].charCodeAt(0));
  const free: string[] = [];
  for (let code = 0xe000; code <= 0xf8ff && free.length <= occurrences.length; code++) {
    if (!used.has(code)) free.push(String.fromCharCode(code));
  }
  const filler = free.pop();
  if (filler === undefined || free.length < occurrences.length) {
    throw new Error('Too many placeholders to analyze in this template.');
  }
  return occurrences.map((o, i) => (free[i] ?? '') + filler.repeat(o.innerEnd - o.innerStart - 1));
}

/** Where a marker was found in the tree. */
type MarkerPlace =
  | { readonly kind: 'text'; readonly parent: ParentNode; readonly inTemplate: boolean; readonly node: ChildNode }
  | { readonly kind: 'comment'; readonly data: string }
  | {
      readonly kind: 'attribute';
      readonly element: HtmlElement;
      readonly name: string;
      readonly prefix: string | undefined;
      readonly value: string;
    }
  | { readonly kind: 'markup' };

function findMarkers(doc: HtmlDocument, markers: readonly string[]): Map<number, MarkerPlace> {
  const index = new Map(markers.map((marker, i) => [marker.charAt(0), i]));
  const found = new Map<number, MarkerPlace>();
  const scan = (text: string, place: MarkerPlace): void => {
    for (const match of text.matchAll(/[\uE000-\uF8FF]/g)) {
      const i = index.get(match[0]);
      if (i !== undefined && text.startsWith(markers[i] ?? '', match.index) && !found.has(i)) found.set(i, place);
    }
  };
  for (const { node, inTemplate } of descendants(doc, true)) {
    if (isElement(node)) {
      scan(node.tagName, { kind: 'markup' });
      for (const attr of node.attrs) {
        scan(attr.name, { kind: 'markup' });
        scan(attr.value, { kind: 'attribute', element: node, name: attr.name, prefix: attr.prefix, value: attr.value });
      }
    } else if ('value' in node) {
      const parent = node.parentNode;
      if (parent !== null) scan(node.value, { kind: 'text', parent, inTemplate, node });
    } else if ('data' in node) {
      scan(node.data, { kind: 'comment', data: node.data });
    } else {
      scan(`${node.name} ${node.publicId} ${node.systemId}`, { kind: 'markup' });
    }
  }
  return found;
}

/** URL attributes: their value is read as a URL. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'action',
  'background',
  'cite',
  'codebase',
  'formaction',
  'href',
  'icon',
  'longdesc',
  'manifest',
  'ping',
  'poster',
  'src',
  'srcset',
  'usemap',
]);

/** Elements whose text is never decoded: shown as written. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['xmp', 'plaintext']);

/** The site of an occurrence whose marker is at `place`; script and style contexts are filled in later. */
function siteOf(html: string, place: MarkerPlace, occurrence: PlaceholderOccurrence, marker: string): PlaceholderSite {
  const delimited =
    html.slice(occurrence.start, occurrence.innerStart) + marker + html.slice(occurrence.innerEnd, occurrence.end);
  // A delimiter right before or after a placeholder's name can only be read apart from it in a tag, so in a comment
  // or text it is read with it.
  if (place.kind === 'markup') return { context: { kind: 'markup' }, delimiters: 'split' };
  if (place.kind === 'comment') return { context: { kind: 'comment' }, delimiters: 'inside' };
  if (place.kind === 'text') return { context: textContext(html, place, occurrence), delimiters: 'inside' };
  const { element, name, prefix, value } = place;
  const quote = attributeQuote(html, element, prefix === undefined || prefix === '' ? name : `${prefix}:${name}`);
  const url = element.namespaceURI === HTML_NS ? URL_ATTRIBUTES.has(name) : name === 'href';
  const context: InsertionContext = { kind: 'attribute', quote, url };
  if (value.includes(delimited)) return { context, delimiters: 'inside' };
  return {
    context,
    delimiters: value === marker && quote === '"' && delimited.startsWith('"') ? 'attribute' : 'split',
  };
}

/** The quote of an attribute value as written: `"`, `'` or none. */
function attributeQuote(html: string, element: HtmlElement, rawName: string): '"' | "'" | '' {
  const location = element.sourceCodeLocation?.attrs?.[rawName];
  if (location === undefined) return '';
  const afterName = html.slice(location.startOffset + rawName.length, location.endOffset);
  const quote = /^[\t\n\f\r ]*=[\t\n\f\r ]*(["'])/.exec(afterName)?.[1];
  return quote === '"' || quote === "'" ? quote : '';
}

/** The context of text: that of its parent element (script and style contexts are filled in later). */
function textContext(
  html: string,
  place: Extract<MarkerPlace, { kind: 'text' }>,
  occurrence: PlaceholderOccurrence,
): InsertionContext {
  const { parent, node } = place;
  // After a plaintext start tag the tokenizer reads the rest of the document as text, also where the tree builder
  // puts it into formatting elements it reopens inside the plaintext element.
  if (insidePlaintext(parent)) return { kind: 'raw-text', element: 'plaintext' };
  if (!isElement(parent)) return { kind: 'text', dropsLeadingNewline: false };
  if (parent.namespaceURI !== HTML_NS) {
    const start = node.sourceCodeLocation?.startOffset ?? occurrence.start;
    return inCdata(html.slice(start, occurrence.start))
      ? { kind: 'raw-text', element: parent.tagName }
      : { kind: 'text', dropsLeadingNewline: false };
  }
  const name = parent.tagName;
  // Script and style text get their own contexts (see `resolveCodeContexts()`).
  if (name === 'script' || name === 'style' || RAW_TEXT_ELEMENTS.has(name)) return { kind: 'raw-text', element: name };
  // The parser drops a line feed right after a `pre`, `listing` or `textarea` start tag.
  const first = parent.sourceCodeLocation?.startTag?.endOffset === occurrence.start;
  return { kind: 'text', dropsLeadingNewline: first && LEADING_NEWLINE_ELEMENTS.has(name) };
}

/** Whether `node` is, or is inside, an HTML plaintext element. */
function insidePlaintext(node: ParentNode): boolean {
  let current: ParentNode | null = node;
  while (current !== null && isElement(current)) {
    if (current.tagName === 'plaintext' && current.namespaceURI === HTML_NS) return true;
    current = current.parentNode;
  }
  return false;
}

/** Elements whose start tag the parser drops a line feed right after. */
const LEADING_NEWLINE_ELEMENTS: ReadonlySet<string> = new Set(['pre', 'listing', 'textarea']);

/**
 * Whether the end of `source`, the text of foreign content (SVG or MathML) before a placeholder, is inside a CDATA
 * section. In that text, `<![CDATA[` always starts a section and `]]>` ends it.
 */
function inCdata(source: string): boolean {
  const open = source.lastIndexOf('<![CDATA[');
  return open !== -1 && !source.includes(']]>', open + 9);
}

/** The JavaScript MIME type essences (WHATWG MIME Sniffing), for which a script element holds a classic script. */
const JAVASCRIPT_TYPES: ReadonlySet<string> = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** What a script element holds, from its `type` attribute (as HTML's "prepare the script element" reads it). */
function scriptLanguage(script: HtmlElement): 'classic' | 'module' | 'json' | 'data' {
  const type = attributeOf(script, 'type');
  const language = attributeOf(script, 'language');
  if (type === '' || (type === undefined && (language === undefined || language === ''))) return 'classic';
  const typeString = (type ?? `text/${language ?? ''}`).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
  if (JAVASCRIPT_TYPES.has(typeString)) return 'classic';
  if (typeString === 'module') return 'module';
  const essence = typeString.split(';')[0]?.trim() ?? '';
  return essence === 'application/json' || essence === 'text/json' || essence.endsWith('+json') ? 'json' : 'data';
}

/** A placeholder in the text of a script or style element: its site index, and its range in that text. */
interface CodeRange extends SourceRange {
  readonly index: number;
}

/** Fill in the contexts of placeholders in script and style text, tokenizing each element's text once. */
function resolveCodeContexts(
  html: string,
  occurrences: readonly PlaceholderOccurrence[],
  sites: readonly PlaceholderSite[],
  found: ReadonlyMap<number, MarkerPlace>,
): PlaceholderSite[] {
  // The text of a script or style element starts where its start tag ends.
  const byElement = new Map<HtmlElement, { readonly textStart: number; readonly ranges: CodeRange[] }>();
  for (const [index, place] of found) {
    if (place.kind !== 'text' || !isElement(place.parent) || place.parent.namespaceURI !== HTML_NS) continue;
    const textStart = place.parent.sourceCodeLocation?.startTag?.endOffset;
    const occurrence = occurrences[index];
    if (!CODE_ELEMENTS.has(place.parent.tagName) || textStart === undefined || occurrence === undefined) continue;
    const group = byElement.get(place.parent) ?? { textStart, ranges: [] };
    group.ranges.push({ index, start: occurrence.start - textStart, end: occurrence.end - textStart });
    byElement.set(place.parent, group);
  }
  const resolved = [...sites];
  for (const [element, { textStart, ranges }] of byElement) {
    const textEnd = element.sourceCodeLocation?.endTag?.startOffset ?? html.length;
    for (const { range, context } of codeContexts(element, html.slice(textStart, textEnd), ranges)) {
      const whole =
        (context.kind === 'script' || context.kind === 'json') && context.js.kind === 'string' && context.js.whole;
      const delimiters = whole ? 'string' : (sites[range.index]?.delimiters ?? 'split');
      resolved[range.index] = { context, delimiters };
    }
  }
  return resolved;
}

/** Elements whose text is code: script and style. */
const CODE_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

function codeContexts(
  element: HtmlElement,
  source: string,
  ranges: readonly CodeRange[],
): InContext<CodeRange, InsertionContext>[] {
  if (element.tagName === 'style') {
    return cssContexts(source, ranges).map(({ range, context: css }) => ({ range, context: { kind: 'style', css } }));
  }
  const language = scriptLanguage(element);
  if (language === 'data') return ranges.map((range) => ({ range, context: { kind: 'raw-text', element: 'script' } }));
  const module = language === 'module';
  return javaScriptContexts(source, ranges, module).map(({ range, context: js }) => {
    const escapable = source.slice(0, range.start).includes('<!--');
    const context: InsertionContext =
      language === 'json' ? { kind: 'json', js, escapable } : { kind: 'script', module, js, escapable };
    return { range, context };
  });
}
