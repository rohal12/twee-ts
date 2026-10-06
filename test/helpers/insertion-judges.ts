/**
 * Run each HTML insertion of twee-ts on a template and judge the result with the parse5 oracle
 * (`html-oracle.ts`). Each judge returns `undefined` when the result is right, or why it is not.
 *
 * "Right" means: the inserted nodes are where they belong (module and head file content and the Vite client in the
 * head; the IFID comment before the store area; story data as live elements; a story name with its value), and the
 * rest of the document builds the same DOM as the template; or, where that is impossible, the template is left as
 * Tweego leaves it and a diagnostic says so.
 */
import { Script } from 'node:vm';
import { fillFormatTemplate } from '../../src/template.js';
import { insertViteClient } from '../../src/html-structure.js';
import { HTML_NS, isElement, parseDocument } from './html.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './html.js';
import { allNodes, hasAttribute, inTemplateContent, judgeHeadInsertion, render } from './html-oracle.js';

const MODULE_SOURCE = "document.documentElement.setAttribute('data-module', '1');";
const MODULE_TAG = `<script id="script-module-probe" type="text/javascript">${MODULE_SOURCE}</script>`;
const HEAD_FILE = '<meta name="probe-head" content="1">';
const IFID_COMMENT = '<!-- UUID://ORACLE-IFID// -->';
/** A story name with every character that some context must escape. */
const TRICKY_NAME = `A&amp B <i>"q" 'a' \\ \`\${x}\` </script> --> ]]> \u2028 =x`;
const TWINE2_DATA =
  '<!-- UUID://X// --><tw-storydata name="probe" hidden><tw-passagedata name="p">x</tw-passagedata></tw-storydata>';
const TWINE1_DATA = '<div tiddler="probe" tags="">x</div>';

const OWNER = 'Probe';

function headFailure(
  template: string,
  head: string,
  isInserted: (node: HtmlNode) => boolean,
  check?: (node: HtmlNode) => boolean,
): string | undefined {
  const { output, diagnostics } = fillFormatTemplate({ template, placeholders: [], head, owner: OWNER });
  if (diagnostics.some((d) => d.message.includes('no place in its head'))) {
    return output === template ? undefined : 'not injected, but the template changed';
  }
  const verdict = judgeHeadInsertion(template, output, isInserted);
  if (verdict.inserted.length !== 1) return `${verdict.inserted.length} inserted nodes found`;
  if (!verdict.inHead) return 'the inserted node is not in the head';
  if (!verdict.restUnchanged) return 'the rest of the document changed';
  const [node] = verdict.inserted;
  if (node !== undefined && check !== undefined && !check(node)) return 'the inserted node is not intact';
  return undefined;
}

/** Modules: a script element at the end of the head, with its text intact. */
export function judgeModule(template: string): string | undefined {
  return headFailure(
    template,
    MODULE_TAG,
    hasAttribute('id', 'script-module-probe'),
    (node) => isElement(node) && node.childNodes.length === 1 && textOf(node) === MODULE_SOURCE,
  );
}

/** The head file: a meta element at the end of the head. */
export function judgeHeadFile(template: string): string | undefined {
  return headFailure(template, HEAD_FILE, hasAttribute('name', 'probe-head'));
}

/**
 * The Vite client: one script element in the head, the rest (and the document mode) unchanged; in a document with no
 * such place (one that is all an unclosed comment), only comments and whitespace may move.
 */
export function judgeViteClient(template: string): string | undefined {
  const output = insertViteClient(template, '/@vite/client');
  const isClient = hasAttribute('src', '/@vite/client');
  const verdict = judgeHeadInsertion(template, output, isClient);
  if (verdict.inserted.length !== 1) return `${verdict.inserted.length} clients found`;
  if (!verdict.inHead) return 'the client is not in the head';
  if (verdict.restUnchanged) return undefined;
  // Comments and inter-element whitespace before the document element move into the head with the client.
  const isComment = (n: HtmlNode): boolean => 'data' in n || ('value' in n && /^[\t\n\f\r ]*$/.test(n.value));
  const sameButComments =
    render(parseDocument(output), (n) => isClient(n) || isComment(n)) === render(parseDocument(template), isComment);
  const placeable = judgeHeadInsertion(
    template,
    insertAt(template, 0, '<script></script>'),
    (n) => isElement(n) && n.tagName === 'script',
  );
  return sameButComments && !placeable.restUnchanged ? undefined : 'the rest of the document changed';
}

function insertAt(text: string, offset: number, insert: string): string {
  return text.slice(0, offset) + insert + text.slice(offset);
}

function textOf(node: HtmlNode): string {
  return allNodes(node)
    .map((n) => ('value' in n ? n.value : ''))
    .join('');
}

/** The first element (outside template contents) whose id is `id`, as `getElementById()` finds it. */
function elementById(doc: HtmlDocument, id: string): HtmlElement | undefined {
  return allNodes(doc).find(
    (n): n is HtmlElement =>
      isElement(n) && !inTemplateContent(n) && n.attrs.some((a) => a.name === 'id' && a.value === id),
  );
}

/** The IFID comment: once, right before the store area (`store-area`, else `storeArea`), the rest unchanged. */
function judgeIfid(template: string): string | undefined {
  const { output, diagnostics } = fillFormatTemplate({
    template,
    placeholders: [],
    beforeStoreArea: IFID_COMMENT,
    owner: OWNER,
  });
  const before = parseDocument(template);
  const store = elementById(before, 'store-area') ?? elementById(before, 'storeArea');
  if (store === undefined) {
    const warned = diagnostics.some((d) => d.message.includes('the IFID comment was not added'));
    return warned && output === template ? undefined : 'no store area, but no warning or a changed template';
  }
  const after = parseDocument(output);
  const comments = allNodes(after).filter((n) => 'data' in n && n.data === ' UUID://ORACLE-IFID// ');
  if (comments.length !== 1) return `${comments.length} IFID comments found`;
  const [comment] = comments;
  if (render(after, (n) => n === comment) !== render(before)) return 'the rest of the document changed';
  // Right before the store area's start tag in the source (where the parser puts a comment there depends on the
  // insertion mode: before the document element, it is a child of the document).
  const storeId = store.attrs.find((a) => a.name === 'id')?.value ?? '';
  const storeAfter = elementById(after, storeId);
  const commentEnd = comment?.sourceCodeLocation?.endOffset;
  return commentEnd !== undefined && storeAfter?.sourceCodeLocation?.startOffset === commentEnd
    ? undefined
    : 'the IFID comment is not right before the store area';
}

/**
 * Brute force: the template with the first occurrence of `token` replaced by `markup` that makes the markup's first
 * element live (HTML namespace, outside template content) and changes nothing else; `undefined` when none does.
 */
function expectedMarkupFill(
  template: string,
  token: string,
  markup: string,
  probe: (n: HtmlNode) => boolean,
): string | undefined {
  for (let i = template.indexOf(token); i !== -1; i = template.indexOf(token, i + token.length)) {
    const candidate = template.slice(0, i) + markup + template.slice(i + token.length);
    const doc = parseDocument(candidate);
    const probes = allNodes(doc).filter(probe);
    const [element] = probes;
    if (probes.length !== 1 || element === undefined || !isElement(element) || element.namespaceURI !== HTML_NS)
      continue;
    if (inTemplateContent(element)) continue;
    // Leave out the markup's nodes: the probe element, and the comment that leads the markup (wherever the parser
    // puts it).
    const lead = /^<!--(.*?)-->/.exec(markup)?.[1];
    const markupNodes = new Set<HtmlNode>([element, ...allNodes(doc).filter((n) => 'data' in n && n.data === lead)]);
    // The template as written, with this placeholder taken out of its text (a private-use character stands in for
    // it, which every tokenizer state reads as the placeholder's characters, and is then removed).
    const stand = String.fromCharCode(0xe123);
    const asWritten = render(parseDocument(template.slice(0, i) + stand + template.slice(i + token.length)));
    const rendered = render(doc, (n) => markupNodes.has(n));
    if (rendered === asWritten.replace(stand, '').replace(/\n *#text $/m, '')) return candidate;
  }
  return undefined;
}

/** Story data (`{{STORY_DATA}}` or Twine 1 `"STORY"`): where the brute-force oracle puts it, or an error. */
function judgeMarkup(template: string, token: '{{STORY_DATA}}' | '"STORY"'): string | undefined {
  const twine2 = token === '{{STORY_DATA}}';
  const markup = twine2 ? TWINE2_DATA : TWINE1_DATA;
  const probe = twine2 ? '<tw-storydata hidden>x</tw-storydata>' : '<div tiddler="">x</div>';
  const { output, diagnostics } = fillFormatTemplate({
    template,
    placeholders: [{ token, occurrences: 'first', value: { kind: 'markup', html: markup, probe } }],
    owner: OWNER,
  });
  const expected = expectedMarkupFill(template, token, markup, hasAttribute(twine2 ? 'name' : 'tiddler', 'probe'));
  if (expected === undefined) {
    if (!template.includes(token)) return output === template ? undefined : 'no placeholder, but the template changed';
    return diagnostics.some((d) => d.level === 'error') ? undefined : 'no live place, but no error';
  }
  return output === expected ? undefined : 'not inserted at the first live place';
}

/** Whether `element` is inside an HTML plaintext element (where formatting elements the parser reopens hold text). */
function insidePlaintext(element: HtmlElement): boolean {
  let current: HtmlNode | null = element;
  while (current !== null && isElement(current)) {
    if (current.tagName === 'plaintext' && current.namespaceURI === HTML_NS) return true;
    current = current.parentNode;
  }
  return false;
}

/** Elements whose text is not decoded (with scripting on), and so holds the escaped form of a value. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'plaintext', 'iframe', 'noembed', 'noframes', 'noscript']);
const URL_ATTRIBUTES = new Set([
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

interface Entry {
  readonly shape: string;
  readonly text?: { readonly value: string; readonly decoded: boolean; readonly script: boolean };
  readonly attrs?: readonly { readonly name: string; readonly value: string; readonly url: boolean }[];
}

/** The nodes of a document as entries: their shape, and the text or attribute values to compare. */
function entries(doc: HtmlDocument): Entry[] {
  return allNodes(doc).map((node): Entry => {
    if (isElement(node)) {
      const html = node.namespaceURI === HTML_NS;
      return {
        shape: `<${node.namespaceURI} ${node.tagName} ${node.attrs.map((a) => a.name).join(' ')}>`,
        attrs: node.attrs.map((a) => ({ name: a.name, value: a.value, url: html && URL_ATTRIBUTES.has(a.name) })),
      };
    }
    if ('value' in node) {
      const parent = node.parentNode;
      const raw =
        parent !== null &&
        isElement(parent) &&
        (parent.namespaceURI !== HTML_NS || RAW_TEXT_ELEMENTS.has(parent.tagName) || insidePlaintext(parent));
      const script =
        parent !== null && isElement(parent) && parent.namespaceURI === HTML_NS && parent.tagName === 'script';
      return { shape: '#text', text: { value: node.value, decoded: !raw, script } };
    }
    return { shape: 'data' in node ? '#comment' : node.nodeName };
  });
}

function compiles(source: string): boolean {
  try {
    new Script(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * The story name in every place (`{{STORY_NAME}}`): the document keeps its shape, decoded text and attribute values
 * hold the name (percent-encoded in a URL attribute), and a script that compiled before still compiles; or there is
 * a warning.
 */
export function judgeStoryName(template: string, name = TRICKY_NAME): string | undefined {
  const token = '{{STORY_NAME}}';
  const { output, diagnostics } = fillFormatTemplate({
    template,
    placeholders: [{ token, occurrences: 'all', value: { kind: 'text', text: name } }],
    owner: OWNER,
  });
  const warned = diagnostics.length > 0;
  // A text node that holds only the placeholder is gone when the name is empty.
  const before = entries(parseDocument(template)).filter((e) => e.text?.value.replaceAll(token, () => name) !== '');
  const after = entries(parseDocument(output));
  const fail = (why: string): string | undefined => (warned ? undefined : why);
  if (before.length !== after.length) return fail('the document changed shape');
  for (const [i, a] of before.entries()) {
    const b = after[i];
    if (a.shape !== b?.shape) return fail(`node ${i} changed: ${a.shape} -> ${b?.shape ?? 'none'}`);
    if (a.text !== undefined && b.text !== undefined) {
      const holds = a.text.value.includes(token);
      if (!holds && a.text.value !== b.text.value) return fail(`text without the placeholder changed at node ${i}`);
      if (holds && a.text.decoded && b.text.value !== a.text.value.replaceAll(token, () => name)) {
        return fail(`text ${JSON.stringify(b.text.value)} does not hold the name`);
      }
      if (holds && a.text.script && compiles(a.text.value.replaceAll(token, () => 'x')) && !compiles(b.text.value)) {
        return fail('a script no longer compiles');
      }
    }
    for (const [k, attr] of (a.attrs ?? []).entries()) {
      const value = b.attrs?.[k]?.value;
      const expected = attr.value.replaceAll(token, () => (attr.url ? encodeURIComponent(name) : name));
      if (value !== expected) return fail(`attribute ${attr.name} is ${JSON.stringify(value)}`);
    }
  }
  return undefined;
}

type Judge = (template: string) => string | undefined;

/** Every judge, by name. */
const JUDGES: Readonly<Record<string, Judge>> = {
  module: judgeModule,
  'head-file': judgeHeadFile,
  'vite-client': judgeViteClient,
  ifid: judgeIfid,
  'story-name': (t) => judgeStoryName(t),
  'story-data': (t) => judgeMarkup(t, '{{STORY_DATA}}'),
  'twine1-story': (t) => judgeMarkup(t, '"STORY"'),
};

/** Collect `[case, judge, failure]` for the judges that fail on `template`. */
export function failures(id: string, template: string): string[] {
  return Object.entries(JUDGES).flatMap(([name, judge]) => {
    let why: string | undefined;
    try {
      why = judge(template);
    } catch (e) {
      why = `threw ${e instanceof Error ? e.message : String(e)}`;
    }
    return why === undefined ? [] : [`${id} [${name}]: ${why}\n    ${JSON.stringify(template)}`];
  });
}
