import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { compile, TweeTsError } from '../src/compiler.js';
import { MAX_HTML_DEPTH } from '../src/html-structure.js';

describe('compile with a deeply nested format template (#314)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'twee-ts-deep-template-'));
    mkdirSync(join(dir, 'Depth'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const build = (open: string, close: string) => {
    const source = `<!doctype html><html><head><title>{{STORY_NAME}}</title></head><body>${open}{{STORY_DATA}}${close}</body></html>`;
    writeFileSync(
      join(dir, 'Depth', 'format.js'),
      `window.storyFormat(${JSON.stringify({ name: 'Depth', version: '1.0.0', source })});`,
    );
    return compile({
      sources: [
        {
          filename: 'story.tw',
          content: ':: StoryTitle\nT\n:: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n:: Start\nhello\n',
        },
      ],
      formatId: 'Depth',
      formatPaths: [dir],
      noRemote: true,
      useTweegoPath: false,
    });
  };

  // `html` and `body` take two levels of the limit, and the story data (`tw-storydata` and its children) two more.
  it('accepts elements nested as deep as the limit', { timeout: 60_000 }, async () => {
    const depth = MAX_HTML_DEPTH - 4;
    const result = await build('<div>'.repeat(depth), '</div>'.repeat(depth));
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('judges a placeholder in template contents nested as deep as the limit, which is not live', async () => {
    const depth = MAX_HTML_DEPTH - 4;
    const result = await build('<template>'.repeat(depth), '</template>'.repeat(depth));
    expect(result.diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('is in text'));
  }, 60_000);

  // #381: reading 20,000 nested elements took seconds, and the parser's time grows with the square of the depth.
  it.each([
    ['elements', '<div>', '</div>'],
    ['template contents', '<template>', '</template>'],
  ])('rejects %s nested 20000 deep, naming the format', async (_name, open, close) => {
    await expect(build(open.repeat(20_000), close.repeat(20_000))).rejects.toThrow(
      new TweeTsError(`Story format "Depth" 1.0.0: HTML nests more than ${String(MAX_HTML_DEPTH)} elements deep.`),
    );
  });

  it('accepts a template of 150000 sibling elements, whose children cannot be passed as call arguments', async () => {
    const result = await build(`<template>${'<i></i>'.repeat(150_000)}</template>`, '');
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  }, 60_000);
});
