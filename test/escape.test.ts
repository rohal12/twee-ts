import { describe, it, expect } from 'vitest';
import {
  attrEscape,
  fullAttrEscape,
  htmlEscape,
  tiddlerEscape,
  tiddlerUnescape,
  tweeEscape,
  tweeUnescape,
  jsStringEscape,
  commentSanitize,
  htmlCommentSanitize,
  rot13,
  scriptContentEscape,
  styleContentEscape,
  cssStringEscape,
} from '../src/escape.js';

describe('attrEscape', () => {
  it('escapes ampersands, quotes, and apostrophes', () => {
    expect(attrEscape('a&b"c\'d')).toBe('a&amp;b&quot;c&#39;d');
  });
  it('returns empty string unchanged', () => {
    expect(attrEscape('')).toBe('');
  });
  it('does not escape < and >', () => {
    expect(attrEscape('<tag>')).toBe('<tag>');
  });
});

describe('htmlEscape', () => {
  it('escapes all special HTML characters', () => {
    expect(htmlEscape('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
  it('returns empty string unchanged', () => {
    expect(htmlEscape('')).toBe('');
  });
});

describe('tiddlerEscape', () => {
  it('escapes tiddler special characters', () => {
    expect(tiddlerEscape('a\\b\tc\nd&e<f>g"h')).toBe('a\\sb\\tc\\nd&amp;e&lt;f&gt;g&quot;h');
  });
  it('returns empty string unchanged', () => {
    expect(tiddlerEscape('')).toBe('');
  });
});

describe('tiddlerUnescape', () => {
  it('unescapes tiddler special characters', () => {
    expect(tiddlerUnescape('a\\sb\\tc\\nd')).toBe('a\\b\tc\nd');
  });
  it('is inverse of tiddlerEscape for relevant chars', () => {
    expect(tiddlerUnescape('\\n\\t\\s')).toBe('\n\t\\');
  });
});

describe('tweeEscape', () => {
  it('escapes backslash, brackets, and braces', () => {
    expect(tweeEscape('a\\b[c]d{e}f')).toBe('a\\\\b\\[c\\]d\\{e\\}f');
  });
  it('returns empty string unchanged', () => {
    expect(tweeEscape('')).toBe('');
  });
});

describe('fullAttrEscape', () => {
  it('escapes all HTML special chars including angle brackets', () => {
    expect(fullAttrEscape('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
  it('returns empty string unchanged', () => {
    expect(fullAttrEscape('')).toBe('');
  });
});

describe('jsStringEscape', () => {
  it('escapes backslashes, quotes, and control characters', () => {
    expect(jsStringEscape('a\\b"c\'d\ne\r\tf')).toBe('a\\\\b\\"c\\\'d\\ne\\r\\tf');
  });
  it('returns empty string unchanged', () => {
    expect(jsStringEscape('')).toBe('');
  });
  it('escapes every < so that the literal cannot end or change the script element around it', () => {
    expect(jsStringEscape('</script><!--<SCRIPT>a<b')).toBe('\\x3C/script>\\x3C!--\\x3CSCRIPT>a\\x3Cb');
  });
  it('escapes the line separators that end a string literal before ES2019', () => {
    expect(jsStringEscape('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c');
  });
  it('keeps the value of a double- or single-quoted string literal', () => {
    const value = 'x</script>\\"\'\n\r\t\u2028\u2029<!--<script>--> é 😀';
    expect(new Function(`return "${jsStringEscape(value)}";`)()).toBe(value);
    expect(new Function(`return '${jsStringEscape(value)}';`)()).toBe(value);
  });
});

describe('cssStringEscape', () => {
  it('escapes backslashes and double quotes', () => {
    expect(cssStringEscape('My "Fancy" \\Font')).toBe('My \\"Fancy\\" \\\\Font');
  });
  it('writes line breaks and other control characters as hex escapes ending in a space', () => {
    expect(cssStringEscape('a\nb\rc\fd\te\u0001f\u007fg')).toBe('a\\a b\\d c\\c d\\9 e\\1 f\\7f g');
  });
  it('leaves other text alone', () => {
    expect(cssStringEscape("Fira Sans 'Bold' é 😀")).toBe("Fira Sans 'Bold' é 😀");
  });
});

describe('commentSanitize', () => {
  it('breaks closing comment sequences', () => {
    expect(commentSanitize('code */ more')).toBe('code * / more');
  });
});

describe('htmlCommentSanitize', () => {
  it('breaks closing HTML comment sequences', () => {
    expect(htmlCommentSanitize('text --> end')).toBe('text -- > end');
  });
  it('breaks the --!> sequence, which also closes an HTML comment', () => {
    expect(htmlCommentSanitize('text --!> end')).toBe('text --! > end');
  });
});

describe('rot13', () => {
  it('encodes uppercase letters', () => {
    expect(rot13('ABC')).toBe('NOP');
  });
  it('encodes lowercase letters', () => {
    expect(rot13('abc')).toBe('nop');
  });
  it('is self-inverse', () => {
    expect(rot13(rot13('Hello, World!'))).toBe('Hello, World!');
  });
  it('leaves non-alphabetic characters unchanged', () => {
    expect(rot13('123!@#')).toBe('123!@#');
  });
  it('returns empty string unchanged', () => {
    expect(rot13('')).toBe('');
  });
});

describe('tweeUnescape', () => {
  it('unescapes backslash-prefixed characters', () => {
    expect(tweeUnescape('a\\\\b\\[c\\]d\\{e\\}f')).toBe('a\\b[c]d{e}f');
  });
  it('is inverse of tweeEscape', () => {
    const original = 'name [with] {special} \\chars';
    expect(tweeUnescape(tweeEscape(original))).toBe(original);
  });
  it('handles trailing backslash gracefully', () => {
    expect(tweeUnescape('test\\')).toBe('test\\');
  });
});

/**
 * Where an HTML parser ends a `<script>` element whose start tag ends just before `html`: the index of the
 * `<` of the end tag that closes it, or -1 if nothing in `html` closes it. A test oracle written from the
 * script data states of the HTML tokenizer (https://html.spec.whatwg.org/#script-data-state), one character
 * at a time, so that it shares nothing with the regular expressions the escaping uses.
 */
function scriptElementEnd(html: string): number {
  type State =
    | 'data'
    | 'lt'
    | 'endTagOpen'
    | 'endTagName'
    | 'escStart'
    | 'escStartDash'
    | 'esc'
    | 'escDash'
    | 'escDashDash'
    | 'escLt'
    | 'escEndTagOpen'
    | 'escEndTagName'
    | 'dblEscStart'
    | 'dblEsc'
    | 'dblEscDash'
    | 'dblEscDashDash'
    | 'dblEscLt'
    | 'dblEscEnd';
  const isAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c);
  const isTerminator = (c: string): boolean => /^[\t\n\f\r />]$/.test(c);
  let state: State = 'data';
  let buffer = '';
  let tagStart = 0;
  let i = 0;
  while (i < html.length) {
    const c = html[i] ?? '';
    let reconsume = false;
    switch (state) {
      case 'data':
        if (c === '<') {
          tagStart = i;
          state = 'lt';
        }
        break;
      case 'lt':
        if (c === '/') {
          buffer = '';
          state = 'endTagOpen';
        } else if (c === '!') state = 'escStart';
        else [state, reconsume] = ['data', true];
        break;
      case 'endTagOpen':
      case 'escEndTagOpen':
        if (isAlpha(c)) [state, reconsume] = [state === 'endTagOpen' ? 'endTagName' : 'escEndTagName', true];
        else [state, reconsume] = [state === 'endTagOpen' ? 'data' : 'esc', true];
        break;
      case 'endTagName':
      case 'escEndTagName':
        if (isTerminator(c) && buffer === 'script') return tagStart;
        if (isAlpha(c)) buffer += c.toLowerCase();
        else [state, reconsume] = [state === 'endTagName' ? 'data' : 'esc', true];
        break;
      case 'escStart':
        if (c === '-') state = 'escStartDash';
        else [state, reconsume] = ['data', true];
        break;
      case 'escStartDash':
        if (c === '-') state = 'escDashDash';
        else [state, reconsume] = ['data', true];
        break;
      case 'esc':
      case 'escDash':
      case 'escDashDash':
        if (c === '-') state = state === 'esc' ? 'escDash' : 'escDashDash';
        else if (c === '<') {
          tagStart = i;
          state = 'escLt';
        } else if (c === '>' && state === 'escDashDash') state = 'data';
        else state = 'esc';
        break;
      case 'escLt':
        if (c === '/') {
          buffer = '';
          state = 'escEndTagOpen';
        } else if (isAlpha(c)) {
          buffer = '';
          [state, reconsume] = ['dblEscStart', true];
        } else [state, reconsume] = ['esc', true];
        break;
      case 'dblEscStart':
        if (isTerminator(c)) state = buffer === 'script' ? 'dblEsc' : 'esc';
        else if (isAlpha(c)) buffer += c.toLowerCase();
        else [state, reconsume] = ['esc', true];
        break;
      case 'dblEsc':
      case 'dblEscDash':
      case 'dblEscDashDash':
        if (c === '-') state = state === 'dblEsc' ? 'dblEscDash' : 'dblEscDashDash';
        else if (c === '<') state = 'dblEscLt';
        else if (c === '>' && state === 'dblEscDashDash') state = 'data';
        else state = 'dblEsc';
        break;
      case 'dblEscLt':
        if (c === '/') {
          buffer = '';
          state = 'dblEscEnd';
        } else [state, reconsume] = ['dblEsc', true];
        break;
      case 'dblEscEnd':
        if (isTerminator(c)) state = buffer === 'script' ? 'esc' : 'dblEsc';
        else if (isAlpha(c)) buffer += c.toLowerCase();
        else [state, reconsume] = ['dblEsc', true];
        break;
      default: {
        const _exhaustive: never = state;
        throw new Error(`unhandled state: ${String(_exhaustive)}`);
      }
    }
    if (!reconsume) i++;
  }
  return -1;
}

/** Where an HTML parser ends a `<style>` element (raw text: only its end tag ends it) whose start tag ends just before `html`. */
function styleElementEnd(html: string): number {
  return html.search(/<\/style[\t\n\f\r />]/i);
}

/** A deterministic pseudo-random generator (mulberry32), so the generated cases are the same on every run. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKUP_PIECES = [
  '<',
  '/',
  '!',
  '-',
  '>',
  ' ',
  '\n',
  '\\',
  '"',
  'x',
  'script',
  'SCRIPT',
  'Script',
  'style',
  'STYLE',
  '<!--',
  '-->',
  '<script>',
  '<script ',
  '</script>',
  '</SCRIPT ',
  '</script/',
  '<style>',
  '</style>',
  '</Style ',
];

function randomMarkup(next: () => number): string {
  const length = Math.floor(next() * 12);
  return Array.from({ length }, () => MARKUP_PIECES[Math.floor(next() * MARKUP_PIECES.length)] ?? '').join('');
}

describe('scriptElementEnd (test oracle)', () => {
  it('finds the end tag the way the HTML tokenizer does', () => {
    expect(scriptElementEnd('a</script>')).toBe(1);
    expect(scriptElementEnd('a</SCRIPT >')).toBe(1);
    expect(scriptElementEnd('a</script/>')).toBe(1);
    expect(scriptElementEnd('a</scripts></script>')).toBe(11);
    expect(scriptElementEnd('<!--</script>')).toBe(4);
    expect(scriptElementEnd('<!--<script></script></script>')).toBe(21);
    expect(scriptElementEnd('<!--<script>--></script>')).toBe(15);
    expect(scriptElementEnd('<!--<script>a</script>')).toBe(-1);
  });
});

describe('scriptContentEscape', () => {
  it('returns text without closing tags or comment openers unchanged', () => {
    expect(scriptContentEscape('')).toBe('');
    expect(scriptContentEscape('if (a < b && c > d) { x = "<b>"; }')).toBe('if (a < b && c > d) { x = "<b>"; }');
    expect(scriptContentEscape('el.innerHTML = "<script>";')).toBe('el.innerHTML = "<script>";');
  });

  it('escapes every closing script tag, in any letter case', () => {
    expect(scriptContentEscape('x = "</script>";')).toBe('x = "<\\/script>";');
    expect(scriptContentEscape('x = "</SCRIPT>" + "</Script >" + "</sCrIpT/>";')).toBe(
      'x = "<\\/SCRIPT>" + "<\\/Script >" + "<\\/sCrIpT/>";',
    );
    expect(scriptContentEscape('x = "</script\tdata-x>";')).toBe('x = "<\\/script\tdata-x>";');
  });

  it('leaves an already escaped closing tag alone', () => {
    expect(scriptContentEscape('document.write("<script><\\/script>");')).toBe(
      'document.write("<script><\\/script>");',
    );
  });

  it('leaves comment openers alone when no script start tag follows them', () => {
    expect(scriptContentEscape('<!-- hide from old browsers\nx = 1;\n// -->')).toBe(
      '<!-- hide from old browsers\nx = 1;\n// -->',
    );
    expect(scriptContentEscape('x = "<!-- <script> -->";')).toBe('x = "<!-- <script> -->";');
  });

  it('escapes comment openers when a script start tag after one would hide the end tag', () => {
    expect(scriptContentEscape('x = "<!--<script>";')).toBe('x = "<\\!--<script>";');
    expect(scriptContentEscape('a = "<!--"; b = "<SCRIPT ";')).toBe('a = "<\\!--"; b = "<SCRIPT ";');
    expect(scriptContentEscape('a = "<!-- -->"; b = "<!--<script>"; c = "</script>";')).toBe(
      'a = "<\\!-- -->"; b = "<\\!--<script>"; c = "<\\/script>";',
    );
  });

  it('is idempotent', () => {
    for (const s of ['x = "</script>";', 'x = "<!--<script>";', '<!-- a --> "</SCRIPT/"']) {
      expect(scriptContentEscape(scriptContentEscape(s))).toBe(scriptContentEscape(s));
    }
  });

  it('keeps the values of JavaScript string, template, and regular expression literals', () => {
    const evaluate = (code: string): unknown => new Function(`return ${code};`)();
    const sources = [
      '"</script>"',
      "'</SCRIPT >'",
      '`</script/>${"</Script\\n"}`',
      '"\\\\</script>"',
      '"<!--<script>" + "</script>"',
      '/<\\/script>|<!--/.source',
      '/[</script>]+/u.exec("a</script>b")?.[0]',
      '"</style>"',
    ];
    for (const source of sources) {
      expect(evaluate(scriptContentEscape(source)), source).toBe(evaluate(source));
    }
  });

  it('keeps every generated text inside its script element', () => {
    const next = prng(107);
    for (let n = 0; n < 5000; n++) {
      const content = scriptContentEscape(randomMarkup(next));
      expect(scriptElementEnd(content + '</script>'), JSON.stringify(content)).toBe(content.length);
    }
  });

  it('is needed for the text the generator makes', () => {
    const next = prng(107);
    const broken = Array.from({ length: 5000 }, () => randomMarkup(next)).filter(
      (s) => scriptElementEnd(s + '</script>') !== s.length,
    );
    expect(broken.length).toBeGreaterThan(100);
  });
});

describe('styleContentEscape', () => {
  it('returns text without closing style tags unchanged', () => {
    expect(styleContentEscape('')).toBe('');
    expect(styleContentEscape('a > b { content: "<style></script>"; }')).toBe('a > b { content: "<style></script>"; }');
  });

  it('escapes every closing style tag, in any letter case', () => {
    expect(styleContentEscape('a::after { content: "</style>"; } /* </STYLE > </Style/> */')).toBe(
      'a::after { content: "<\\/style>"; } /* <\\/STYLE > <\\/Style/> */',
    );
  });

  it('keeps every generated text inside its style element', () => {
    const next = prng(1070);
    for (let n = 0; n < 5000; n++) {
      const content = styleContentEscape(randomMarkup(next));
      expect(styleElementEnd(content + '</style>'), JSON.stringify(content)).toBe(content.length);
    }
  });
});
