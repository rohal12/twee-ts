/**
 * A spec-derived trap matrix for HTML structure location: for each tokenizer state (and tree-construction context)
 * in which text that looks like markup is not markup, or markup ends earlier than a naive reading says, a template
 * that puts a look-alike of a target there, or hides a real target behind it. The expected results come from an
 * oracle (parse5 in the tests, Chrome in a local check), never from this file.
 *
 * Case ids are stable: `<state>/<context>/<target>/<direction>`.
 */

/** What a template's structure is searched for. */
const TARGETS = {
  'head-end': '</head>',
  'head-start': '<head>',
  'body-start': '<body>',
  'store-area': '<div id="storeArea">',
  'store-area-dash': '<div id="store-area">',
  'story-name': '{{STORY_NAME}}',
  'story-data': '{{STORY_DATA}}',
  'twine1-story': '"STORY"',
} as const;

/**
 * Tokenizer states (and constructs) that hold a look-alike: `wrap(payload)` puts `payload` inside the state and
 * leaves the state again; `hide`, where given, opens the state so that a naive reading keeps it open over a real tag
 * that follows, and `close` is what that naive reading takes for its end.
 */
interface TrapState {
  readonly wrap: (payload: string) => string;
  readonly hide?: { readonly open: string; readonly close: string };
}

export const STATES: Readonly<Record<string, TrapState>> = {
  comment: { wrap: (p) => `<!-- ${p} -->` },
  'comment-abrupt-empty': { wrap: (p) => `<!---->${p}`, hide: { open: '<!-->', close: '<!-- -->' } },
  'comment-abrupt-dash': { wrap: (p) => `<!-- a- ${p} -->`, hide: { open: '<!--->', close: '<!-- -->' } },
  'comment-end-bang': { wrap: (p) => `<!-- ${p} --!>`, hide: { open: '<!-- a --!>', close: '-->' } },
  'comment-nested-open': { wrap: (p) => `<!-- <!-- ${p} -->`, hide: { open: '<!-- <!-- -->', close: '-->' } },
  'bogus-comment-bang': { wrap: (p) => `<!x ${p.replace(/>/g, '')}>`, hide: { open: '<!x>', close: '>' } },
  'bogus-comment-question': { wrap: (p) => `<?x ${p.replace(/>/g, '')}>`, hide: { open: '<?x>', close: '?>' } },
  'bogus-comment-end-tag': { wrap: (p) => `</ ${p.replace(/>/g, '')}>`, hide: { open: '</ x>', close: '>' } },
  'bogus-comment-end-bang': { wrap: (p) => `</!${p.replace(/>/g, '')}>`, hide: { open: '</!>', close: '>' } },
  'doctype-identifier': { wrap: (p) => `<!DOCTYPE html PUBLIC "${p.replace(/>/g, '')}">` },
  'rcdata-title': { wrap: (p) => `<title>${p}</title>` },
  'rcdata-textarea': { wrap: (p) => `<textarea>${p}</textarea>` },
  'rawtext-style': { wrap: (p) => `<style>/* ${p} */</style>` },
  'rawtext-xmp': { wrap: (p) => `<xmp>${p}</xmp>` },
  'rawtext-iframe': { wrap: (p) => `<iframe>${p}</iframe>` },
  'rawtext-noembed': { wrap: (p) => `<noembed>${p}</noembed>` },
  'rawtext-noframes': { wrap: (p) => `<noframes>${p}</noframes>` },
  'rawtext-noscript': { wrap: (p) => `<noscript>${p}</noscript>` },
  'script-data': { wrap: (p) => `<script>var s = "${p}";</script>` },
  'script-data-escaped': {
    wrap: (p) => `<script><!-- var s = "${p}"; --></script>`,
    hide: { open: '<script>/*<!--*/', close: '/*-->*/</script>' },
  },
  'script-data-double-escaped': {
    wrap: (p) => `<script>/*<!--<script>*/ var s = "</script>${p}"; /*-->*/</script>`,
    hide: { open: '<script>/*<!--<script>*/ var s = "</script>";', close: '/*-->*/</script>' },
  },
  'script-end-tag-lookalike': { wrap: (p) => `<script>var s = "</scripty>${p}";</script>` },
  plaintext: { wrap: (p) => `<plaintext>${p}` },
  'attribute-double-quoted': { wrap: (p) => `<meta content="${p}">` },
  'attribute-single-quoted': { wrap: (p) => `<meta content='${p}'>` },
  'attribute-unquoted-with-quote': {
    wrap: (p) => `<meta content=a"${p.replace(/[\s>]/g, '')}>`,
    hide: { open: '<meta content=a">', close: '">' },
  },
  'attribute-name-equals': { wrap: (p) => `<meta ="${p}">`, hide: { open: '<meta ="x"="', close: '">' } },
  'attribute-name-quote': { wrap: (p) => `<meta a"b="${p}">`, hide: { open: '<meta a"=b>', close: '">' } },
  'attribute-after-quoted-equals': {
    wrap: (p) => `<meta a="x"="${p}">`,
    hide: { open: '<meta a="x"=b>', close: '">' },
  },
  'cdata-in-foreign': { wrap: (p) => `<svg><![CDATA[ ${p} ]]></svg>` },
  'cdata-in-html': { wrap: (p) => `<![CDATA[ ${p.replace(/>/g, '')} ]]>`, hide: { open: '<![CDATA[ >', close: ']]>' } },
  'template-content': { wrap: (p) => `<template>${p}</template>` },
  'svg-style-is-markup': { wrap: (p) => `<svg><style>${p}</style></svg>` },
};

/** Tree-construction contexts a trap is placed in. */
const CONTEXTS: Readonly<Record<string, (trap: string) => string>> = {
  html: (t) => t,
  template: (t) => `<template>${t}</template>`,
  svg: (t) => `<svg>${t}</svg>`,
  math: (t) => `<math><mi>${t}</mi></math>`,
};

/** Where in the base template a trap goes. */
type Position = 'before-html' | 'head' | 'body';

const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

/**
 * The base template: a Twine 2 and Twine 1 shaped document with every target once, and the trap at `position`
 * (before the real target it concerns).
 */
function baseTemplate(trap: string, position: Position): string {
  const at = (p: Position): string => (p === position ? trap : '');
  return (
    `<!doctype html>${at('before-html')}<html><head><title>{{STORY_NAME}}</title>${at('head')}` +
    `<meta charset="utf-8"></head><body>${at('body')}<h1>{{STORY_NAME}}</h1>` +
    `<div id="storeArea" data-size="STORY_SIZE" hidden>"STORY"</div>{{STORY_DATA}}` +
    `<script>var n = "{{STORY_NAME}}", ifid = "${IFID}";</script></body></html>`
  );
}

export interface TrapCase {
  readonly id: string;
  readonly template: string;
}

/** Every case of the matrix: states × contexts × targets × directions × positions. */
export function trapCases(): TrapCase[] {
  const cases: TrapCase[] = [];
  for (const [stateId, state] of Object.entries(STATES)) {
    for (const [contextId, context] of Object.entries(CONTEXTS)) {
      for (const [targetId, target] of Object.entries(TARGETS)) {
        // Before the document element, the wrapping contexts imply the body as the plain one does.
        const positions =
          contextId === 'html' ? (['before-html', 'head', 'body'] as const) : (['head', 'body'] as const);
        for (const position of positions) {
          cases.push({
            id: `${stateId}/${contextId}/${targetId}/lookalike@${position}`,
            template: baseTemplate(context(state.wrap(target)), position),
          });
          if (state.hide !== undefined) {
            const { open, close } = state.hide;
            cases.push({
              id: `${stateId}/${contextId}/${targetId}/hidden@${position}`,
              template: baseTemplate(context(`${open}${target}${close}`), position),
            });
          }
        }
      }
    }
  }
  return cases;
}
