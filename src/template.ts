/**
 * Single-pass placeholder substitution for story format templates.
 *
 * Every placeholder is found in the template text before anything is inserted, so inserted text (a story title,
 * passage data, a start passage name, module or head file content) is never scanned for placeholders.
 */

/** A placeholder in a template and the text that replaces it. */
export interface TemplateSlot {
  /** Regular expression source matching the placeholder. Must not contain capturing groups. */
  readonly pattern: string;
  /** Replace only the first match in the template, or every match. */
  readonly occurrences: 'first' | 'all';
  /** Text that replaces a match, given the matched text. Inserted literally and called only for a match. */
  readonly replacement: (match: string) => string;
}

/** A piece of a template: text to scan for `slots`, or text inserted as is. */
export type TemplatePart =
  | { readonly kind: 'scan'; readonly text: string; readonly slots: readonly TemplateSlot[] }
  | { readonly kind: 'verbatim'; readonly text: string };

/**
 * An HTML closing head tag: `</head` in any letter case, followed by whitespace, `/` or `>`, up to the next `>`.
 * This is how the HTML tokenizer reads an end tag; it ignores whatever sits between the tag name and the `>`.
 */
export const CLOSING_HEAD_TAG = '<\\/[Hh][Ee][Aa][Dd](?=[\\t\\n\\f\\r />])[^>]*>';

/**
 * The start of an HTML body start tag: `<body` in any letter case, followed by whitespace, `/` or `>` (so not
 * `<bodyx>`). Only the `<body` is matched; the attributes and `>` after it are left alone.
 */
export const BODY_START_TAG = '<[Bb][Oo][Dd][Yy](?=[\\t\\n\\f\\r />])';

/** The regular expression source matching exactly `text`. */
export function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Replace the `slots` placeholders found in `template`, without scanning inserted text. */
export function fillTemplate(template: string, slots: readonly TemplateSlot[]): string {
  return fillTemplateParts([{ kind: 'scan', text: template, slots }]);
}

/**
 * Fill the parts of a template in order, joined. A `'first'` slot replaced in one part is not replaced again in a
 * later part that lists the same slot object.
 */
export function fillTemplateParts(parts: readonly TemplatePart[]): string {
  const filled = new Set<TemplateSlot>();
  return parts
    .map((part) => {
      if (part.kind === 'verbatim' || part.slots.length === 0) return part.text;
      const { slots } = part;
      const pattern = new RegExp(slots.map((slot) => `(${slot.pattern})`).join('|'), 'g');
      return part.text.replace(pattern, (match: string, ...groups: unknown[]) => {
        const slot = slots.find((_, i) => groups[i] !== undefined);
        if (slot === undefined || (slot.occurrences === 'first' && filled.has(slot))) return match;
        filled.add(slot);
        return slot.replacement(match);
      });
    })
    .join('');
}
