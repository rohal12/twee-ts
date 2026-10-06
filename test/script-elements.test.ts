/**
 * Which `<script>` elements in passage text hold JavaScript (#245, PR #256's limitation): SugarCube's
 * `verbatimScriptTag` parser hands the element to jQuery 3.7.1, which runs a script only when its `type`
 * passes jQuery's own filter, never runs the content of one with a `src`, and evaluates the content by
 * copying `type`, `src`, `nonce` and `noModule` onto a new script element, which the browser then runs
 * by HTML's script type rules. The oracle below restates those rules from the two specifications,
 * independently of `src/html-structure.ts`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { scriptsJQueryRuns } from '../src/html-structure.js';
import { findPassageLinks } from '../src/sugarcube-macros.js';
import { javaScriptStrings } from '../src/javascript-strings.js';
import { storyInspect } from '../src/inspect.js';
import { parseTwee } from '../src/parser.js';
import { StoryBuilder } from '../src/story.js';

/** WHATWG MIME Sniffing: the JavaScript MIME type essences. */
const JS_ESSENCES = [
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
];

/** The attributes of one generated script element; `undefined` leaves the attribute out. */
interface ScriptAttributes {
  readonly type: string | undefined;
  readonly language: string | undefined;
  readonly src: string | undefined;
  readonly nomodule: boolean;
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The oracle: how a script with these attributes runs when jQuery appends it, or 'none'. */
function oracle({ type, src, nomodule }: ScriptAttributes): 'classic' | 'module' | 'none' {
  // jQuery 3.7.1 domManip: rscriptType on `node.type || ""`; a src is loaded, the content never read.
  const raw = type ?? '';
  if (!/^$|^module$|\/(?:java|ecma)script/i.test(raw)) return 'none';
  if (src !== undefined) return 'none';
  // DOMEval copies a non-empty type (not `language`); HTML's "prepare the script element" decides.
  let kind: 'classic' | 'module' | 'none';
  if (raw === '') kind = 'classic';
  else {
    const typeString = asciiLower(raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''));
    kind = JS_ESSENCES.includes(typeString) ? 'classic' : typeString === 'module' ? 'module' : 'none';
  }
  return kind === 'classic' && nomodule ? 'none' : kind;
}

const quoteAttr = (value: string): string => `"${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;

function element(attrs: ScriptAttributes, code: string): string {
  const parts = [
    attrs.type === undefined ? '' : ` type=${quoteAttr(attrs.type)}`,
    attrs.language === undefined ? '' : ` language=${quoteAttr(attrs.language)}`,
    attrs.src === undefined ? '' : ` src=${quoteAttr(attrs.src)}`,
    attrs.nomodule ? ' nomodule' : '',
  ];
  return `<script${parts.join('')}>${code}</script>`;
}

const CODE = `$.wiki('<<goto "Room">>')`;

function runs(attrs: ScriptAttributes): 'classic' | 'module' | 'none' {
  const scripts = scriptsJQueryRuns(element(attrs, CODE));
  expect(scripts.length).toBeLessThanOrEqual(1);
  const [script] = scripts;
  if (script === undefined) return 'none';
  expect(script.code).toBe(CODE);
  return script.kind;
}

const none: ScriptAttributes = { type: undefined, language: undefined, src: undefined, nomodule: false };

describe('scriptsJQueryRuns: which script elements run, and how (table)', () => {
  const cases: readonly [string, ScriptAttributes][] = [
    ['no type', none],
    ['an empty type', { ...none, type: '' }],
    ['type text/javascript', { ...none, type: 'text/javascript' }],
    ['type TEXT/JavaScript', { ...none, type: 'TEXT/JavaScript' }],
    ['type text/javascript with white space around', { ...none, type: ' \ttext/javascript\n' }],
    ['type text/javascript with a charset parameter', { ...none, type: 'text/javascript; charset=utf-8' }],
    ['type application/ecmascript', { ...none, type: 'application/ecmascript' }],
    ['type application/x-javascript', { ...none, type: 'application/x-javascript' }],
    ['type text/javascript1.5', { ...none, type: 'text/javascript1.5' }],
    ['type text/jscript (jQuery does not run it)', { ...none, type: 'text/jscript' }],
    ['type text/livescript (jQuery does not run it)', { ...none, type: 'text/livescript' }],
    ['type module', { ...none, type: 'module' }],
    ['type MODULE', { ...none, type: 'MODULE' }],
    ['type module with white space', { ...none, type: ' module ' }],
    ['type text/template', { ...none, type: 'text/template' }],
    ['type text/x-template', { ...none, type: 'text/x-template' }],
    ['type application/json', { ...none, type: 'application/json' }],
    ['type importmap', { ...none, type: 'importmap' }],
    ['type speculationrules', { ...none, type: 'speculationrules' }],
    ['type text/x-javascript-template', { ...none, type: 'text/x-javascript-template' }],
    ['type of only white space', { ...none, type: '  ' }],
    ['a language attribute and no type', { ...none, language: 'vbscript' }],
    ['an empty language attribute', { ...none, language: '' }],
    ['a src attribute', { ...none, src: 'lib.js' }],
    ['an empty src attribute', { ...none, src: '' }],
    ['a module with a src attribute', { ...none, type: 'module', src: 'lib.js' }],
    ['nomodule on a classic script', { ...none, nomodule: true }],
    ['nomodule on a module script', { ...none, type: 'module', nomodule: true }],
  ];
  it.each(cases)('%s', (_label, attrs) => {
    expect(runs(attrs)).toBe(oracle(attrs));
  });

  it('agrees with the oracle on the expected kinds of the table', () => {
    expect(cases.map(([, attrs]) => oracle(attrs))).toEqual([
      'classic',
      'classic',
      'classic',
      'classic',
      'classic',
      'none',
      'classic',
      'none',
      'classic',
      'none',
      'none',
      'module',
      'module',
      'none',
      'none',
      'none',
      'none',
      'none',
      'none',
      'none',
      'none',
      'classic',
      'classic',
      'none',
      'none',
      'none',
      'none',
      'module',
    ]);
  });
});

describe('scriptsJQueryRuns: the element as the HTML parser builds it', () => {
  it('reads attributes as HTML does: names in any case, character references, the first of duplicates', () => {
    expect(scriptsJQueryRuns(`<script TYPE="text/template">x</script>`)).toEqual([]);
    expect(scriptsJQueryRuns(`<script type="text&#x2F;template">x</script>`)).toEqual([]);
    expect(scriptsJQueryRuns(`<script type=module type="text/template">x</script>`)).toEqual([
      { kind: 'module', code: 'x' },
    ]);
    expect(scriptsJQueryRuns(`<script type='text/template' type=module>x</script>`)).toEqual([]);
  });

  it('follows the parse when the element ends before the closing tag SugarCube looks for', () => {
    expect(scriptsJQueryRuns(`<script>a()</script ><script type="text/template">b</script>`)).toEqual([
      { kind: 'classic', code: 'a()' },
    ]);
    expect(scriptsJQueryRuns(`<script type="text/template">a</script ><script>b()</script>`)).toEqual([
      { kind: 'classic', code: 'b()' },
    ]);
  });

  it('runs no script inside template contents, and strips the comment and CDATA wrappers jQuery strips', () => {
    expect(scriptsJQueryRuns(`<script>a()</script\t><template><script>b()</script></template>`)).toEqual([
      { kind: 'classic', code: 'a()' },
    ]);
    expect(scriptsJQueryRuns(`<script> <!--\na()\n--> </script>`)).toEqual([{ kind: 'classic', code: '\na()\n' }]);
    expect(scriptsJQueryRuns(`<script><![CDATA[a()]]></script>`)).toEqual([{ kind: 'classic', code: 'a()' }]);
  });
});

describe('scriptsJQueryRuns agrees with the oracle (property-based)', () => {
  const typeValue = fc.oneof(
    fc.constantFrom(...JS_ESSENCES, 'module', 'text/template', 'importmap', 'application/json', ''),
    fc
      .constantFrom(...JS_ESSENCES, 'module')
      .chain((t) =>
        fc
          .tuple(
            fc.constantFrom('', ' ', '\t', '\n', '\f'),
            fc.constantFrom('', ' ', '\r\n', '\t'),
            fc.constantFrom('', ';charset=utf-8', '1.6', 'x'),
            fc.boolean(),
          )
          .map(([before, after, suffix, upper]) => `${before}${upper ? t.toUpperCase() : t}${suffix}${after}`),
      ),
    fc.string({ maxLength: 12 }),
  );
  const attributes = fc.record({
    type: fc.option(typeValue, { nil: undefined }),
    language: fc.option(fc.constantFrom('', 'javascript', 'vbscript'), { nil: undefined }),
    src: fc.option(fc.constantFrom('', 'a.js'), { nil: undefined }),
    nomodule: fc.boolean(),
  });
  it('runs a script exactly when the oracle says, in the oracle’s kind', () => {
    fc.assert(
      fc.property(attributes, (attrs) => {
        // The parser turns CR and CR LF into LF in attribute values; the oracle reads what it gives.
        const parsed = { ...attrs, type: attrs.type?.replace(/\r\n?/g, '\n').replace(/\0/g, '�') };
        expect(runs(attrs)).toBe(oracle(parsed));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('links in <script> elements of passage text', () => {
  it('reads links only in scripts that run', () => {
    expect(findPassageLinks(`<script type="text/template"><<goto "T">></script>`)).toEqual([]);
    expect(findPassageLinks(`<script type="text/template">$.wiki('<<goto "T">>')</script>`)).toEqual([]);
    expect(findPassageLinks(`<script type="text/javascript">$.wiki('<<goto "J">>')</script>`)).toEqual([
      { via: 'goto', passage: 'J' },
    ]);
    expect(findPassageLinks(`<script type="module">$.wiki('<<goto "M">>')</script>`)).toEqual([
      { via: 'goto', passage: 'M' },
    ]);
    expect(findPassageLinks(`<script src="x.js">$.wiki('<<goto "S">>')</script>`)).toEqual([]);
  });

  it('reads a module script as module code: strict strings and no HTML-like comments', () => {
    // Octal escapes are rejected in a module (strict) and read in a classic script (sloppy).
    const octal = `$.wiki("\\74\\74goto 'Octal'>>")`;
    expect(findPassageLinks(`<script>${octal}</script>`)).toEqual([{ via: 'goto', passage: 'Octal' }]);
    expect(findPassageLinks(`<script type="module">${octal}</script>`)).toEqual([]);
    // `<!--` starts a comment in a classic script only.
    expect(javaScriptStrings(`x = 1 <!--"a"\n"b"`, 'sloppy')).toEqual(['b']);
    expect(javaScriptStrings(`x = 1 <!--"a"\n"b"`, 'module')).toEqual(['a', 'b']);
    expect(javaScriptStrings(`export const a = "<<goto 'M'>>"; await f();`, 'module')).toEqual(["<<goto 'M'>>"]);
  });

  it('reports a broken link in a module script and none in a template script, end to end', () => {
    const brokenLinks = (text: string): string[] => {
      const twee = `:: StoryTitle\nT\n\n:: Start\n${text}\n`;
      const builder = new StoryBuilder();
      for (const passage of parseTwee(twee).passages) builder.add(passage, []);
      return storyInspect(builder.build()).brokenLinks.map((link) => link.to);
    };
    expect(brokenLinks(`<script type="text/x-template"><<goto "Ghost">>[[Phantom]]</script>`)).toEqual([]);
    expect(brokenLinks(`<script type="module">$.wiki('<<goto "Missing">>')</script>`)).toEqual(['Missing']);
    expect(brokenLinks(`<script>$.wiki('<<goto "Gone">>')</script>`)).toEqual(['Gone']);
  });
});
