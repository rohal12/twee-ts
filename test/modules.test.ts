import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Diagnostic } from '../src/types.js';
import { compile } from '../src/compiler.js';
import { loadModules, modifyHead } from '../src/modules.js';

let tmpDir: string;

describe('loadModules', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads CSS files as <style> tags', () => {
    const file = join(tmpDir, 'theme.css');
    writeFileSync(file, 'body { color: red; }');
    const result = loadModules([file]);
    expect(result).toContain('<style');
    expect(result).toContain('body { color: red; }');
    expect(result).toContain('type="text/css"');
    expect(result).toContain('id="style-module-theme"');
  });

  it('loads JS files as <script> tags', () => {
    const file = join(tmpDir, 'app.js');
    writeFileSync(file, 'console.log("hi")');
    const result = loadModules([file]);
    expect(result).toContain('<script');
    expect(result).toContain('console.log("hi")');
    expect(result).toContain('type="text/javascript"');
    expect(result).toContain('id="script-module-app"');
  });

  it.each([
    ['script', 'js', (pos: number) => `globalThis.out="${'a'.repeat(pos)}\0b";`],
    ['style', 'css', (pos: number) => `a::before { content: "${'a'.repeat(pos)}\0b"; }`],
  ] as const)('reports U+0000 in a %s module as an error, wherever it is', (_kind, ext, make) => {
    for (const pos of [0, 1, 40]) {
      const file = join(tmpDir, `nul${pos}.${ext}`);
      writeFileSync(file, make(pos));
      const diagnostics: Diagnostic[] = [];
      loadModules([file], diagnostics);
      expect(diagnostics).toEqual([
        {
          level: 'error',
          message: `The module "${file}" contains U+0000, which HTML cannot carry: the browser drops it or reads it as U+FFFD. Remove it.`,
        },
      ]);
    }
  });

  it('reports a lone surrogate in a module, and nothing for ordinary text', () => {
    const lone = join(tmpDir, 'lone.js');
    writeFileSync(lone, Buffer.from([0xed, 0xa0, 0x80]));
    const fine = join(tmpDir, 'fine.js');
    writeFileSync(fine, 'globalThis.out="ab \u{1F600}";');
    const diagnostics: Diagnostic[] = [];
    loadModules([fine], diagnostics);
    expect(diagnostics).toEqual([]);
    const loneDiagnostics: Diagnostic[] = [];
    loadModules([lone], loneDiagnostics);
    expect(loneDiagnostics.map((d) => d.level)).toContain('warning');
  });

  it('fails compile() on a module with U+0000, as the same file loaded as a source does', async () => {
    const file = join(tmpDir, 'module.js');
    writeFileSync(file, 'globalThis.out="a\0b";');
    const story =
      ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nProbe\n\n:: Start\nHello.\n';
    const common = {
      formatId: 'test-format-1',
      formatPaths: ['test/fixtures/storyformats'],
      useTweegoPath: false,
      noRemote: true,
    };
    const asModule = await compile({ ...common, sources: [{ filename: 's.tw', content: story }], modules: [file] });
    expect(asModule.diagnostics.filter((d) => d.level === 'error').map((d) => d.message)).toEqual([
      expect.stringContaining('contains U+0000'),
    ]);
  });

  it('escapes closing script tags in JS files', () => {
    const file = join(tmpDir, 'tags.js');
    writeFileSync(file, 'document.write("<script src=x.js></SCRIPT >");');
    const result = loadModules([file]);
    expect(result).toBe(
      '<script id="script-module-tags" type="text/javascript">document.write("<script src=x.js><\\/SCRIPT >");</script>',
    );
  });

  it('escapes closing style tags in CSS files', () => {
    const file = join(tmpDir, 'tags.css');
    writeFileSync(file, 'p::after { content: "</Style>"; }');
    const result = loadModules([file]);
    expect(result).toBe('<style id="style-module-tags" type="text/css">p::after { content: "<\\/Style>"; }</style>');
  });

  it('loads font files as @font-face style blocks', () => {
    const file = join(tmpDir, 'myfont.woff2');
    writeFileSync(file, Buffer.from([0x00, 0x01]));
    const result = loadModules([file]);
    expect(result).toContain('@font-face');
    expect(result).toContain('font-family: "myfont"');
    expect(result).toContain('font/woff2');
    expect(result).toContain('format("woff2")');
  });

  // Windows file names cannot hold `"`, `\` or a line break.
  it.skipIf(process.platform === 'win32')('writes the font family as a valid CSS string', () => {
    const file = join(tmpDir, 'My "Fancy" \\Font\nTwo.woff');
    writeFileSync(file, 'FONT');
    expect(loadModules([file])).toContain(
      '\tfont-family: "My \\"Fancy\\" \\\\Font\\a Two";\n\tsrc: url("data:font/woff;base64,Rk9OVA==") format("woff");\n}',
    );
  });

  it('skips duplicate files', () => {
    const file = join(tmpDir, 'dup.css');
    writeFileSync(file, 'body {}');
    const result = loadModules([file, file]);
    const count = (result.match(/<style/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('skips empty CSS/JS files', () => {
    const file = join(tmpDir, 'empty.css');
    writeFileSync(file, '   ');
    const result = loadModules([file]);
    expect(result).toBe('');
  });

  it('skips unknown file types', () => {
    const file = join(tmpDir, 'readme.md');
    writeFileSync(file, '# Hello');
    const result = loadModules([file]);
    expect(result).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(loadModules([])).toBe('');
  });
});

describe('modifyHead', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseHtml = '<html><head><title>Test</title></head><body></body></html>';

  it('injects module content before </head>', () => {
    const file = join(tmpDir, 'inject.css');
    writeFileSync(file, 'h1 { font-size: 2em; }');
    const result = modifyHead(baseHtml, [file]);
    expect(result).toContain('<style');
    expect(result).toContain('</head>');
    expect(result.indexOf('<style')).toBeLessThan(result.indexOf('</head>'));
  });

  it('injects head file content before </head>', () => {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta name="custom" content="value">');
    const result = modifyHead(baseHtml, [], headFile);
    expect(result).toContain('<meta name="custom" content="value">');
  });

  it.each(['</HEAD>', '</Head>', '</head >', '</head\n>'])('injects before a closing head tag written %j', (close) => {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta name="review" content="injected">');
    const result = modifyHead(`<html><head><title>Test</title>${close}<body></body></html>`, [], headFile);
    expect(result).toBe(
      `<html><head><title>Test</title><meta name="review" content="injected">\n${close}<body></body></html>`,
    );
  });

  it('injects only before the first closing head tag', () => {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta>');
    expect(modifyHead('<head></HEAD><body></head></body>', [], headFile)).toBe(
      '<head><meta>\n</HEAD><body></head></body>',
    );
  });

  it('returns original HTML when no modules or head file', () => {
    expect(modifyHead(baseHtml, [])).toBe(baseHtml);
  });

  it('injects before the body start tag, with a warning, when there is no closing head tag', () => {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta>');
    const diagnostics: Diagnostic[] = [];
    expect(modifyHead('<html><title>T</title><BODY class="x"></body>', [], headFile, diagnostics)).toBe(
      '<html><title>T</title><meta>\n<BODY class="x"></body>',
    );
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'The HTML has no closing head tag that ends its head; the modules and head file were injected where the ' +
          'head ends, at line 1, column 23.',
      },
    ]);
  });

  it('injects where the parser creates the head when there is no head or body tag (not at <bodyx> or <tbody>)', () => {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta>');
    const diagnostics: Diagnostic[] = [];
    const html = '<table><tbody></tbody></table><bodyx>';
    expect(modifyHead(html, [], headFile, diagnostics)).toBe(`<meta>\n${html}`);
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message:
          'The HTML has no closing head tag that ends its head; the modules and head file were injected where the ' +
          'head ends, at line 1, column 1.',
      },
    ]);
  });

  it('reports nothing for HTML without head or body tags when there is nothing to inject', () => {
    const diagnostics: Diagnostic[] = [];
    expect(modifyHead('<p>hi</p>', [], undefined, diagnostics)).toBe('<p>hi</p>');
    expect(diagnostics).toEqual([]);
  });

  it('preserves $& and other replacement patterns in module content', () => {
    const file = join(tmpDir, 'regex-lib.js');
    writeFileSync(file, 'var x = "test".replace(/t/, "$&$&");');
    const result = modifyHead(baseHtml, [file]);
    expect(result).toContain('$&$&');
    expect(result).not.toContain('</head></head>');
  });

  it("preserves $` and $' replacement patterns in module content", () => {
    const file = join(tmpDir, 'patterns.js');
    writeFileSync(file, 'var a = "$`"; var b = "$\'";');
    const result = modifyHead(baseHtml, [file]);
    expect(result).toContain('$`');
    expect(result).toContain("$'");
  });

  it('collects diagnostics for missing head file', () => {
    const diagnostics: Diagnostic[] = [];
    const result = modifyHead(baseHtml, [], join(tmpDir, 'missing.html'), diagnostics);
    expect(result).toBe(baseHtml);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.level).toBe('warning');
    expect(diagnostics[0]!.message).toContain('Failed to read head file');
  });
});

describe('modifyHead HTML context', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function inject(html: string, diagnostics?: Diagnostic[]): string {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta>');
    return modifyHead(html, [], headFile, diagnostics);
  }

  it('injects at the real closing head tag, not one inside a script', () => {
    expect(inject('<head><script>var c = "</head>";</script></head><body></body>')).toBe(
      '<head><script>var c = "</head>";</script><meta>\n</head><body></body>',
    );
  });

  it('injects at the real closing head tag, not one inside a comment', () => {
    expect(inject('<head><!-- </head> --></head><body></body>')).toBe(
      '<head><!-- </head> --><meta>\n</head><body></body>',
    );
  });

  it('uses the real body start tag when there is no closing head tag', () => {
    const diagnostics: Diagnostic[] = [];
    expect(inject('<script>var b = "<body>";</script><!-- <body> --><body class="x">', diagnostics)).toBe(
      '<script>var b = "<body>";</script><!-- <body> --><meta>\n<body class="x">',
    );
    expect(diagnostics).toHaveLength(1);
  });

  it('injects at the end of the implied head, with a warning, when the only head and body tags are in a script or comment', () => {
    const diagnostics: Diagnostic[] = [];
    const html = '<script>"</head><body>"</script><!-- </head><body> -->';
    expect(inject(html, diagnostics)).toBe(`${html}<meta>\n`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('has no closing head tag that ends its head');
  });

  it('is not misled by an unterminated closing head tag in a script', () => {
    expect(inject('<head><script>"</head"; x</script></head><body>')).toBe(
      '<head><script>"</head"; x</script><meta>\n</head><body>',
    );
  });
});

describe('module injection through the renderers, with tags in other HTML contexts', () => {
  const STORY = {
    filename: 'story.tw',
    content: ':: StoryTitle\nCtx\n\n:: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nHello\n',
  };
  const META = '<meta name="review" content="injected">';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function options(kind: 'twine2' | 'twine1', template: string) {
    const formats = join(tmpDir, 'formats');
    const id = kind === 'twine2' ? 'ctx-2' : 'ctx-1';
    mkdirSync(join(formats, id), { recursive: true });
    if (kind === 'twine2') {
      const format = { name: 'Ctx', version: '1.0.0', source: template };
      writeFileSync(join(formats, id, 'format.js'), `window.storyFormat(${JSON.stringify(format)});`);
    } else {
      writeFileSync(join(formats, id, 'header.html'), template);
    }
    const module = join(tmpDir, 'module.js');
    writeFileSync(module, 'globalThis.moduleRan = true;');
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, META);
    return {
      sources: [STORY],
      formatId: id,
      formatPaths: [formats],
      useTweegoPath: false,
      noRemote: true,
      modules: [module],
      headFile,
    };
  }

  const template = (kind: 'twine2' | 'twine1', head: string, closeHead = true) =>
    `<html><head>${head}${closeHead ? '</head>' : ''}<body>` +
    (kind === 'twine2' ? '{{STORY_DATA}}' : '<div id="storeArea">"STORY"</div>') +
    '</body></html>';

  for (const kind of ['twine2', 'twine1'] as const) {
    describe(`${kind} template`, () => {
      it.each([
        ['an inline script', '<script>const close = "</head>";</script>'],
        ['an HTML comment', '<!-- </head> -->'],
        ['a style element', '<style>/* </head> */</style>'],
        ['an attribute value', '<meta name="x" content="</head>">'],
      ])('injects before the real closing head tag, not one in %s', async (_label, context) => {
        const result = await compile(options(kind, template(kind, context)));

        expect(result.diagnostics).toEqual([]);
        expect(result.output.startsWith(`<html><head>${context}<script id="script-module-module"`)).toBe(true);
        expect(result.output.split(META)).toHaveLength(2);
        expect(result.output).toContain(`${META}\n</head><body>`);
      });

      it.each([
        ['an inline script', '<script>const open = "<body>";</script>'],
        ['an HTML comment', '<!-- <body> -->'],
      ])('injects before the real body start tag, not one in %s, without a closing head tag', async (_l, context) => {
        const result = await compile(options(kind, template(kind, context, false)));

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.message).toContain('no closing head tag');
        expect(result.output.startsWith(`<html><head>${context}<script id="script-module-module"`)).toBe(true);
        expect(result.output).toContain(`${META}\n<body>`);
        expect(result.output.split(META)).toHaveLength(2);
      });

      it('keeps injecting before an ordinary closing head tag', async () => {
        const result = await compile(options(kind, template(kind, '<title>T</title>')));

        expect(result.diagnostics).toEqual([]);
        expect(result.output).toContain('<title>T</title><script id="script-module-module"');
        expect(result.output).toContain(`${META}\n</head><body>`);
      });
    });
  }
});
