/**
 * A browser-equivalent oracle for HTML insertions: parse5 (with scripting enabled, as story formats run) parses the
 * template and the output, and these helpers say whether an insertion put its nodes where they belong and left
 * everything else as it was. Nothing here uses the code under test.
 */
import type { DefaultTreeAdapterTypes } from 'parse5';
import { HTML_NS, isElement, parseDocument } from './html.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './html.js';

type ParentNode = DefaultTreeAdapterTypes.ParentNode;

function childrenOf(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

/**
 * A canonical rendering of a parsed document: every node with its kind, namespace, name, attributes and text (with
 * adjacent text merged), template contents, and the document mode. Nodes for which `skip` is true are left out, with
 * their subtrees. Two documents with the same rendering build the same DOM.
 */
export function render(doc: HtmlDocument, skip: (node: HtmlNode) => boolean = () => false): string {
  const out: string[] = [`mode:${doc.mode}`];
  const walk = (node: HtmlNode, depth: number): void => {
    for (const child of childrenOf(node)) {
      if (skip(child)) continue;
      const pad = ' '.repeat(depth);
      if (isElement(child)) {
        const attrs = child.attrs.map((a) => `${a.prefix ?? ''}:${a.name}=${JSON.stringify(a.value)}`).join(' ');
        out.push(`${pad}<${child.namespaceURI === HTML_NS ? '' : `${child.namespaceURI} `}${child.tagName} ${attrs}>`);
        walk(child, depth + 1);
        if ('content' in child) {
          out.push(`${pad} #content`);
          walk(child.content, depth + 2);
        }
      } else if ('value' in child) {
        const last = out.at(-1);
        const text = `${pad}#text `;
        if (last?.startsWith(text) === true) out[out.length - 1] = last + JSON.stringify(child.value).slice(1, -1);
        else out.push(text + JSON.stringify(child.value).slice(1, -1));
      } else if ('data' in child) {
        out.push(`${pad}#comment ${JSON.stringify(child.data)}`);
      } else if ('publicId' in child) {
        out.push(`${pad}#doctype ${JSON.stringify([child.name, child.publicId, child.systemId])}`);
      }
    }
  };
  walk(doc, 0);
  return out.join('\n');
}

/** Every node in tree order, including template contents. */
export function allNodes(root: HtmlNode): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    found.push(node);
    childrenOf(node).forEach(visit);
    if ('content' in node) visit(node.content);
  };
  childrenOf(root).forEach(visit);
  if ('content' in root) visit(root.content);
  return found;
}

/** The head element of a document: the `head` child of the root `html` element. */
export function documentHead(doc: HtmlDocument): HtmlElement | undefined {
  const root = doc.childNodes.find((n): n is HtmlElement => isElement(n) && n.tagName === 'html');
  return root?.childNodes.find((n): n is HtmlElement => isElement(n) && n.tagName === 'head');
}

/** Whether `node` is inside the content of a template element. */
export function inTemplateContent(node: HtmlNode): boolean {
  let parent: ParentNode | null = 'parentNode' in node ? node.parentNode : null;
  while (parent !== null) {
    if (parent.nodeName === '#document-fragment') return true;
    parent = 'parentNode' in parent ? parent.parentNode : null;
  }
  return false;
}

/** The verdict on an insertion into a document's head. */
export interface HeadVerdict {
  /** The nodes that are the insertion, found by `isInserted` in the output. */
  readonly inserted: readonly HtmlNode[];
  /** Whether every inserted top-level node is a child of the document's head (HTML namespace). */
  readonly inHead: boolean;
  /** Whether the output without the inserted nodes builds the same DOM as the template. */
  readonly restUnchanged: boolean;
}

/**
 * Judge an insertion of nodes into the head of `template`, giving `output`: `isInserted` tells the inserted nodes
 * apart (by an id, a `src`, or comment text no template holds).
 */
export function judgeHeadInsertion(
  template: string,
  output: string,
  isInserted: (node: HtmlNode) => boolean,
): HeadVerdict {
  const before = parseDocument(template);
  const after = parseDocument(output);
  const head = documentHead(after);
  const inserted = allNodes(after).filter(isInserted);
  const inHead = inserted.every((node) => {
    const parent = 'parentNode' in node ? node.parentNode : null;
    return parent === head && (!isElement(node) || node.namespaceURI === HTML_NS);
  });
  // Whitespace text right after the inserted nodes may come from the insertion too (the line break after the head
  // content), so the rest is compared with and without it.
  const insertedSet = new Set(inserted);
  const skip = (node: HtmlNode): boolean => {
    if (insertedSet.has(node)) return true;
    if (!('value' in node) || node.parentNode === null) return false;
    const siblings = node.parentNode.childNodes;
    const previous = siblings[siblings.indexOf(node) - 1];
    return previous !== undefined && insertedSet.has(previous) && /^[\t\n\f\r ]*$/.test(node.value);
  };
  const expected = render(before);
  const restUnchanged = render(after, skip) === expected || render(after, (n) => insertedSet.has(n)) === expected;
  return { inserted, inHead, restUnchanged };
}

/** Whether a node is an element with the attribute `name` set to `value`. */
export function hasAttribute(name: string, value: string): (node: HtmlNode) => boolean {
  return (node) => isElement(node) && node.attrs.some((a) => a.name === name && a.value === value);
}
