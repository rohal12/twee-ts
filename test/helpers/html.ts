/**
 * Reading HTML in tests the way a browser reads it: parse5 with scripting enabled, the oracle for where elements end
 * up. (htmlparser2 is no oracle: it builds no HTML tree, so implied and ignored tags, template contents and the
 * script escape states differ from a browser's.)
 */
import { parse, html as htmlSpec } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

export type HtmlDocument = DefaultTreeAdapterTypes.Document;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export type HtmlNode = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export const HTML_NS = htmlSpec.NS.HTML;

/** Parse a document as a browser does, with source locations. */
export function parseDocument(html: string): HtmlDocument {
  return parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true });
}

export function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

/** Every node under `root` in tree order; template contents too when `intoTemplates`. */
function nodes(root: HtmlNode, intoTemplates = false): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    found.push(node);
    if ('childNodes' in node) node.childNodes.forEach(visit);
    if (intoTemplates && 'content' in node) visit(node.content);
  };
  if ('childNodes' in root) root.childNodes.forEach(visit);
  if (intoTemplates && 'content' in root) visit(root.content);
  return found;
}

/** The elements of `html` (outside template contents) that `matches`, in tree order. */
export function elements(
  html: string | HtmlNode,
  matches: (element: HtmlElement) => boolean = () => true,
): HtmlElement[] {
  const root = typeof html === 'string' ? parseDocument(html) : html;
  return nodes(root).filter((node): node is HtmlElement => isElement(node) && matches(node));
}

/** An attribute value of an element, or `undefined`. */
export function attr(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** The DOM `textContent` of a node. */
export function textContent(node: HtmlNode): string {
  return nodes(node)
    .map((n) => ('value' in n ? n.value : ''))
    .join('');
}

/** The tag name of an element's parent element, or `undefined`. */
export function parentTag(element: HtmlElement): string | undefined {
  const parent: ParentNode | null = element.parentNode;
  return parent !== null && isElement(parent) ? parent.tagName : undefined;
}

/** The text of each script element in `html` (outside template contents), read as a browser reads it. */
export function scriptTexts(html: string): string[] {
  return elements(html, (e) => e.tagName === 'script' && e.namespaceURI === HTML_NS).map(textContent);
}
