// @ts-check

/**
 * HTML structure is located by parsing (src/html-structure.ts), never by matching markup text (issue #244): outside
 * that module, no string search, comparison or regular expression looks for a head, body or html tag, a doctype or
 * the Twine 1 store area.
 */
const HTML_STRUCTURE_PATTERN = String.raw`/<\/?(head|body|html)\b|<!doctype|store-?area|<div\s+id/i`;
const SEARCH_CALL = String.raw`CallExpression[callee.property.name=/^(indexOf|lastIndexOf|includes|startsWith|endsWith|search|match|matchAll|replace|replaceAll|split)$/]`;
const HTML_STRUCTURE_MESSAGE = 'Find HTML structure with src/html-structure.ts (parse5), not by matching markup text.';
export const HTML_STRUCTURE_RESTRICTIONS = [
  { selector: `${SEARCH_CALL} > Literal.arguments[value=${HTML_STRUCTURE_PATTERN}]`, message: HTML_STRUCTURE_MESSAGE },
  {
    selector: `${SEARCH_CALL} > TemplateLiteral.arguments > TemplateElement[value.raw=${HTML_STRUCTURE_PATTERN}]`,
    message: HTML_STRUCTURE_MESSAGE,
  },
  {
    selector: `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=${HTML_STRUCTURE_PATTERN}]`,
    message: HTML_STRUCTURE_MESSAGE,
  },
  {
    selector: `NewExpression[callee.name='RegExp'] > Literal.arguments[value=/head|body|store-?area|doctype/i]`,
    message: HTML_STRUCTURE_MESSAGE,
  },
  { selector: `Literal[regex.pattern=/head|body|store-?area|doctype/i]`, message: HTML_STRUCTURE_MESSAGE },
];
