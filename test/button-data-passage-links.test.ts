/**
 * Links that `<<button>>` calls and elements with a `data-passage` attribute make (#293), read as SugarCube 2.37.3
 * reads them: `<<button>>` is registered with `<<link>>`'s handler, and an element is a link when its `htmlTag`
 * parser makes it from a start tag with a `data-passage` attribute (`processDataAttributes`).
 */
import { describe, it, expect } from 'vitest';
import { findJavaScriptPassageLinks, findPassageLinks } from '../src/sugarcube-macros.js';
import { storyInspect } from '../src/inspect.js';
import { lint } from '../src/lint.js';
import { parseTwee } from '../src/parser.js';
import { StoryBuilder } from '../src/story.js';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

const passages = (text: string): string[] => findPassageLinks(text).map((link) => link.passage);

describe('<<button>> calls name a passage as <<link>> calls do', () => {
  it.each([
    ['<<button "Go" "Kitchen">><</button>>', [{ via: 'button', passage: 'Kitchen' }]],
    ["<<button 'Go' Kitchen>><</button>>", [{ via: 'button', passage: 'Kitchen' }]],
    ['<<button [[Go|Kitchen]]>><</button>>', [{ via: 'markup', passage: 'Kitchen' }]],
    ['<<button [[Go|Kitchen]] "Hall">><</button>>', [{ via: 'markup', passage: 'Kitchen' }]],
    ['<<button "Go">><<goto "Hall">><</button>>', [{ via: 'goto', passage: 'Hall' }]],
    ['<<button "Go" $next>><</button>>', []],
    ['<<button>><</button>>', []],
    ['<<buttons "Go" "Kitchen">>', []],
    [`<<set _b to '<<button "Go" "Kitchen">><</button>>'>>`, [{ via: 'button', passage: 'Kitchen' }]],
    ['<<if <<button "Go" "Kitchen">>', [{ via: 'button', passage: 'Kitchen' }]],
  ] as const)('%s', (text, expected) => {
    expect(findPassageLinks(text)).toEqual(expected);
  });
});

describe('elements with a data-passage attribute are links', () => {
  it.each([
    ['<a data-passage="Hall">h</a>', ['Hall']],
    ["<button data-passage='Hall'>h</button>", ['Hall']],
    ['<span data-passage=Hall>h</span>', ['Hall']],
    ['<A DATA-PASSAGE="Hall">h</A>', ['Hall']],
    ['<a\ndata-passage = "Hall"\n>h</a  >', ['Hall']],
    ['<my-link data-passage="Hall">h</my-link>', ['Hall']],
    // Void elements, and a start tag that ends with `/>`, need no end tag.
    ['<area data-passage="Hall">', ['Hall']],
    ['<input type="button" data-passage="Hall">', ['Hall']],
    ['<span data-passage="Hall"/>', ['Hall']],
    // A setter is run on the click; the passage is still the link's.
    ['<a data-passage="Hall" data-setter="$x to 1">h</a>', ['Hall']],
    // The value is read as the browser reads it, and evaluated as a link's passage is.
    ['<a data-passage="Hall &amp; Co">h</a>', ['Hall & Co']],
    [`<a data-passage="'Hall'">h</a>`, ['Hall']],
    // An attribute written twice: the browser keeps the first.
    ['<a data-passage="Hall" data-passage="Other">h</a>', ['Hall']],
    // The element's content is read on as markup; the start tag's text is not.
    ['<a data-passage="Hall">[[Room]]</a>', ['Hall', 'Room']],
    ['<a title="[[Room]]" data-passage="Hall">h</a>', ['Hall']],
    ['<span title="<<goto `Room`>>">x</span>', []],
    // In strings that SugarCube wikifies.
    [`<<set _a to '<a data-passage="Hall">h</a>'>>`, ['Hall']],
    [`<<script>>$('#out').wiki('<a data-passage="Hall">h</a>')<</script>>`, ['Hall']],
    [`<script>$('#out').wiki('\\x3ca data-passage="Hall">h</a>')</script>`, ['Hall']],
  ] as const)('%s', (text, expected) => {
    expect(passages(text)).toEqual(expected);
  });

  it.each([
    ['no end tag', '<a data-passage="Hall">h'],
    ['an end tag of another element', '<a data-passage="Hall">h</b>'],
    ['an empty value', '<a data-passage="">h</a>'],
    ['also an href (an error in SugarCube)', '<a data-passage="Hall" href="#">h</a>'],
    ['a directive that sets the passage in play', '<a @data-passage="$next">h</a>'],
    ['a directive that sets the passage over the attribute', '<a data-passage="Hall" sc-eval:data-passage="$n">h</a>'],
    ['a directive that sets an href', '<a data-passage="Hall" @href="$url">h</a>'],
    ['a directive on data-setter (an error in SugarCube)', '<a data-passage="Hall" @data-setter="$s">h</a>'],
    ['a media element, which names a media passage', '<img data-passage="Hall">'],
    ['a source element', '<audio><source data-passage="Hall"></audio>'],
    ['an element the browser does not make there', '<td data-passage="Hall">h</td>'],
    ['a <style> element, read by its own parser', '<style data-passage="Hall">p {}</style>'],
    ['an <svg> element, read by its own parser', '<svg data-passage="Hall"></svg>'],
    ['a start tag that is not one SugarCube matches', '<a data-passage="Hall"'],
    ['a value with no closing quote', '<a data-passage="Hall>h</a>'],
    ['a comment', '/* <a data-passage="Hall">h</a> */'],
    ['an HTML comment', '<!-- <a data-passage="Hall">h</a> -->'],
    ['link markup that holds it', '[[<a data-passage="Hall">|Room]]'],
  ])('names no passage with %s', (_name, text) => {
    expect(passages(text).filter((p) => p === 'Hall')).toEqual([]);
  });

  it('reads them in a script passage only inside strings', () => {
    expect(findJavaScriptPassageLinks(`$('#out').wiki('<a data-passage="Hall">h</a>');`)).toEqual([
      { via: 'data-passage', passage: 'Hall' },
    ]);
    expect(findJavaScriptPassageLinks('if (a<b data-passage="Hall">c) {}')).toEqual([]);
  });

  it('reads a start tag that swallows link markup as SugarCube does: the markup is attribute text', () => {
    expect(passages('x<y [[Room]] z> [[Hall]]')).toEqual(['Hall']);
  });
});

describe('reading start tags stays linear in the size of the text', () => {
  it.each([
    ['unclosed start tags', '<a '.repeat(100_000)],
    ['start tags with no end tags', '<a data-passage="x">'.repeat(30_000)],
    ['many tag names with no end tags', Array.from({ length: 30_000 }, (_, i) => `<t${String(i)}>`).join('')],
    ['unclosed quoted values', `<a b='`.repeat(50_000)],
  ])('reads %s quickly', (_name, text) => {
    const started = performance.now();
    findPassageLinks(text);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('inspect and lint see <<button>> and data-passage links (#293)', () => {
  const source = [
    ':: StoryData',
    `{"ifid":"${IFID}"}`,
    '',
    ':: Start',
    '<<button "Go" "Kitchen">><</button>> <a data-passage="Hall">h</a> <<button "Go" "Kitchn">><</button>>',
    '',
    ':: Kitchen',
    'k',
    '',
    ':: Hall',
    'h',
  ].join('\n');

  it('lists the links, so Start is no dead end and Kitchen and Hall are no orphans', () => {
    const builder = new StoryBuilder();
    for (const p of parseTwee(source).passages) builder.add(p, []);
    const map = storyInspect(builder.build());
    expect(map.links.get('Start')).toEqual(['Kitchen', 'Kitchn', 'Hall']);
    expect(map.deadEnds).not.toContain('Start');
    expect(map.orphans).toEqual([]);
    expect(map.brokenLinks).toEqual([{ from: 'Start', to: 'Kitchn' }]);
  });

  it('reports the misspelt button target as a broken link', async () => {
    const result = await lint({ sources: [{ filename: 'story.tw', content: source }] });
    expect(result.brokenLinks).toEqual([{ from: 'Start', to: 'Kitchn' }]);
    expect(result.deadEnds).toEqual(['Kitchen', 'Hall']);
    expect(result.orphans).toEqual([]);
  });
});
