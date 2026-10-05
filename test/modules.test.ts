import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Diagnostic } from '../src/types.js';
import { loadModules, modifyHead } from '../src/modules.js';

let tmpDir: string;

describe('loadModules', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

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
    const count = (result.match(/<style/g) || []).length;
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
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

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
        message: 'The HTML has no closing head tag; the modules and head file were injected before its body start tag.',
      },
    ]);
  });

  it('does not take <bodyx> or <tbody> for a body start tag', () => {
    const headFile = join(tmpDir, 'head.html');
    writeFileSync(headFile, '<meta>');
    const diagnostics: Diagnostic[] = [];
    const html = '<table><tbody></tbody></table><bodyx>';
    expect(modifyHead(html, [], headFile, diagnostics)).toBe(html);
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: 'The HTML has no closing head tag and no body start tag; the modules and head file were not injected.',
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
