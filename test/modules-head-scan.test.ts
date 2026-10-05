import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { findHeadStartEnd, loadHeadContent, loadModules, scanHeadTags } from '../src/modules.js';

describe('scanHeadTags: text that only looks like markup', () => {
  it('skips a lone < in text and finds the tags after it', () => {
    const html = '<html><head><title>a</title><p>1 < 2</p></head><body>x</body></html>';
    expect(scanHeadTags(html).closingHead).toBe(html.indexOf('</head>'));
    expect(scanHeadTags(html).bodyStart).toBe(html.indexOf('<body>'));
  });

  it('finds nothing after an unterminated doctype or processing instruction', () => {
    expect(scanHeadTags('<!doctype html <body')).toEqual({ closingHead: undefined, bodyStart: undefined });
    expect(scanHeadTags('<?xml version="1.0" <body')).toEqual({
      closingHead: undefined,
      bodyStart: undefined,
    });
  });

  it('ends a tag with an unterminated quoted attribute value at the end of the text', () => {
    expect(scanHeadTags('<p class="open </head><body>')).toEqual({ closingHead: undefined, bodyStart: undefined });
  });

  it('reads an attribute value after whitespace following the equals sign, quoted or not', () => {
    const html = '<head data-x =  "a>b" data-y=  c></head><body>';
    expect(scanHeadTags(html).closingHead).toBe(html.indexOf('</head>'));
    expect(findHeadStartEnd(html)).toBe(html.indexOf('></head>') + 1);
  });
});

describe('loadModules: font types', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'twee-ts-modules-fonts-'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

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
