/**
 * Which `@import` rules of the story stylesheet a browser ignores. CSS accepts `@import` only before every other
 * rule, apart from `@charset`, `@layer` statements and `@namespace`; the story's stylesheet passages are joined into
 * one stylesheet, so an import that opens a later source comes after the rules of the earlier ones. Tweego joins them
 * the same way, so twee-ts keeps the text and reports the import instead.
 *
 * The scan reads the top level of the stylesheet as CSS Syntax Level 3 tokenizes it: comments, strings, escapes,
 * `url()` and bracketed blocks hide the characters inside them; a statement ends at a `;` or at the `}` that closes
 * its block.
 */
import type { Diagnostic } from './types.js';

/** A stylesheet source of the story, with the name its diagnostics call it by. */
export interface StylesheetSource {
  readonly label: string;
  readonly text: string;
}

/** What a top-level statement is, as far as the position of `@import` is concerned. */
type Statement = 'import' | 'prelude' | 'rule';

/** The statements at the top level of `css`, in order. */
function topLevelStatements(css: string): Statement[] {
  const statements: Statement[] = [];
  let depth = 0;
  let head = '';
  let started = false;
  const finish = (): void => {
    if (!started) return;
    const word = /^@([-\w]+)/.exec(head.trimStart());
    const name = word?.[1]?.toLowerCase();
    statements.push(name === 'import' ? 'import' : name === 'charset' || name === 'namespace' ? 'prelude' : 'rule');
    head = '';
    started = false;
  };
  let i = 0;
  while (i < css.length) {
    const ch = css.charAt(i);
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css.charAt(j) !== ch && !'\n\r\f'.includes(css.charAt(j)))
        j += css.charAt(j) === '\\' ? 2 : 1;
      if (depth === 0) {
        started = true;
        head += css.slice(i, j + 1);
      }
      i = css.charAt(j) === ch ? j + 1 : j;
      continue;
    }
    if (ch === '\\') {
      if (depth === 0) {
        started = true;
        head += css.slice(i, i + 2);
      }
      i += 2;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      if (depth === 0) started = true;
      depth += 1;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      // A block closed at the top level ends a qualified rule or an at-rule.
      if (depth === 0 && ch === '}') {
        finish();
        i += 1;
        continue;
      }
    } else if (ch === ';' && depth === 0) {
      // An at-rule without a block ends here; so does a stray declaration, which is a (dropped) rule.
      const word = /^@([-\w]+)/.exec(head.trimStart());
      const name = word?.[1]?.toLowerCase();
      if (name === 'layer') {
        started = false;
        head = '';
        statements.push('prelude');
      } else {
        finish();
      }
      i += 1;
      continue;
    } else if (depth === 0 && !/\s/.test(ch)) {
      started = true;
    }
    if (depth === 0) head += ch;
    i += 1;
  }
  finish();
  return statements;
}

/**
 * A warning for each source whose `@import` rules come after a rule of the story stylesheet, which a browser ignores:
 * the imported stylesheet is never requested.
 */
export function ineffectiveImportDiagnostics(sources: readonly StylesheetSource[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let ruleSeen = false;
  for (const { label, text } of sources) {
    let ignored = 0;
    for (const statement of topLevelStatements(text)) {
      if (statement === 'rule') ruleSeen = true;
      else if (statement === 'import' && ruleSeen) ignored += 1;
    }
    if (ignored > 0) {
      diagnostics.push({
        level: 'warning',
        message:
          `${label} has ${ignored === 1 ? 'an @import rule' : `${ignored} @import rules`} after other style rules ` +
          'in the story stylesheet, so browsers ignore ' +
          `${ignored === 1 ? 'it' : 'them'} and never load the imported stylesheet. ` +
          'Move the import to the start of the first stylesheet, or add the file as a head module.',
      });
    }
  }
  return diagnostics;
}
