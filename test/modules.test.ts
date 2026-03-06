import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import type { Diagnostic } from '../src/types.js';
import { loadModules, modifyHead } from '../src/modules.js';

const TMP_DIR = join(__dirname, '__tmp_modules__');

describe('loadModules', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('loads CSS files as <style> tags', () => {
    const file = join(TMP_DIR, 'theme.css');
    writeFileSync(file, 'body { color: red; }');
    const result = loadModules([file]);
    expect(result).toContain('<style');
    expect(result).toContain('body { color: red; }');
    expect(result).toContain('type="text/css"');
    expect(result).toContain('id="style-module-theme"');
  });

  it('loads JS files as <script> tags', () => {
    const file = join(TMP_DIR, 'app.js');
    writeFileSync(file, 'console.log("hi")');
    const result = loadModules([file]);
    expect(result).toContain('<script');
    expect(result).toContain('console.log("hi")');
    expect(result).toContain('type="text/javascript"');
    expect(result).toContain('id="script-module-app"');
  });

  it('loads font files as @font-face style blocks', () => {
    const file = join(TMP_DIR, 'myfont.woff2');
    writeFileSync(file, Buffer.from([0x00, 0x01]));
    const result = loadModules([file]);
    expect(result).toContain('@font-face');
    expect(result).toContain('font-family: "myfont"');
    expect(result).toContain('font/woff2');
    expect(result).toContain('format("woff2")');
  });

  it('skips duplicate files', () => {
    const file = join(TMP_DIR, 'dup.css');
    writeFileSync(file, 'body {}');
    const result = loadModules([file, file]);
    const count = (result.match(/<style/g) || []).length;
    expect(count).toBe(1);
  });

  it('skips empty CSS/JS files', () => {
    const file = join(TMP_DIR, 'empty.css');
    writeFileSync(file, '   ');
    const result = loadModules([file]);
    expect(result).toBe('');
  });

  it('skips unknown file types', () => {
    const file = join(TMP_DIR, 'readme.md');
    writeFileSync(file, '# Hello');
    const result = loadModules([file]);
    expect(result).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(loadModules([])).toBe('');
  });
});

describe('modifyHead', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  const baseHtml = '<html><head><title>Test</title></head><body></body></html>';

  it('injects module content before </head>', () => {
    const file = join(TMP_DIR, 'inject.css');
    writeFileSync(file, 'h1 { font-size: 2em; }');
    const result = modifyHead(baseHtml, [file]);
    expect(result).toContain('<style');
    expect(result).toContain('</head>');
    expect(result.indexOf('<style')).toBeLessThan(result.indexOf('</head>'));
  });

  it('injects head file content before </head>', () => {
    const headFile = join(TMP_DIR, 'head.html');
    writeFileSync(headFile, '<meta name="custom" content="value">');
    const result = modifyHead(baseHtml, [], headFile);
    expect(result).toContain('<meta name="custom" content="value">');
  });

  it('returns original HTML when no modules or head file', () => {
    expect(modifyHead(baseHtml, [])).toBe(baseHtml);
  });

  it('collects diagnostics for missing head file', () => {
    const diagnostics: Diagnostic[] = [];
    const result = modifyHead(baseHtml, [], join(TMP_DIR, 'missing.html'), diagnostics);
    expect(result).toBe(baseHtml);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe('warning');
    expect(diagnostics[0].message).toContain('Failed to read head file');
  });
});
