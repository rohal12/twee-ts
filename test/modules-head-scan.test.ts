import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadHeadContent, loadModules } from '../src/modules.js';
import { locateHeadEnd, locateHeadStart } from '../src/html-structure.js';

describe('locating the head: text that only looks like markup', () => {
  it('skips a lone < in text and finds the closing head tag after it', () => {
    const html = '<html><head><title>a</title></head><body><p>1 < 2</p></body></html>';
    expect(locateHeadEnd(html)).toEqual({ offset: html.indexOf('</head>'), how: 'end-tag' });
  });

  it('reads a doctype or processing instruction as the browser does, up to the first >', () => {
    const doctype = '<!doctype html <body><head></head>';
    expect(locateHeadEnd(doctype)).toEqual({ offset: doctype.indexOf('</head>'), how: 'end-tag' });
    const pi = '<?xml version="1.0" <body><head></head>';
    expect(locateHeadEnd(pi)).toEqual({ offset: pi.indexOf('</head>'), how: 'end-tag' });
  });

  it('drops a tag with an unterminated quoted attribute value, as the browser does at the end of the document', () => {
    const html = '<head><title>t</title><p class="open </head><body>';
    expect(locateHeadEnd(html)).toEqual({ offset: html.indexOf('<p'), how: 'implicit-end' });
  });

  it('reads an attribute value after whitespace following the equals sign, quoted or not', () => {
    const html = '<head data-x =  "a>b" data-y=  c></head><body>';
    expect(locateHeadEnd(html)).toEqual({ offset: html.indexOf('</head>'), how: 'end-tag' });
    expect(locateHeadStart(html)).toEqual({ offset: html.indexOf('></head>') + 1, how: 'start-tag' });
  });
});

describe('loadModules: font types', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-fonts-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['otf', 'ttf', 'woff', 'woff2'])('embeds a .%s file as a base64 @font-face', (ext) => {
    const file = join(tmpDir, `Face.${ext}`);
    writeFileSync(file, 'font-bytes');
    const result = loadModules([file]);
    expect(result).toContain('@font-face');
    expect(result).toContain(Buffer.from('font-bytes').toString('base64'));
  });

  it('warns instead of throwing when the head file cannot be read', () => {
    const diagnostics: { level: string; message: string }[] = [];
    const content = loadHeadContent([], join(tmpDir, 'missing.html'), diagnostics as never);
    expect(content).toBe('');
    expect(diagnostics.some((d) => d.level === 'warning' && d.message.includes('missing.html'))).toBe(true);
  });
});
