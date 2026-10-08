import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { compile } from '../src/compiler.js';

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
          content: ':: StoryData\n{"ifid":"12345678-1234-4234-8234-123456789ABC"}\n:: Start\nhello\n',
        },
      ],
      formatId: 'Depth',
      formatPaths: [dir],
      noRemote: true,
      useTweegoPath: false,
    });
  };

  it('accepts 20000 nested elements', { timeout: 60_000 }, async () => {
    const result = await build('<div>'.repeat(20_000), '</div>'.repeat(20_000));
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  });

  it('judges a placeholder in 20000 nested template contents, which is not live, without overflowing the stack', async () => {
    const result = await build('<template>'.repeat(20_000), '</template>'.repeat(20_000));
    expect(result.diagnostics.map((d) => d.message)).toContainEqual(expect.stringContaining('is in text'));
  }, 60_000);

  it('accepts a template of 150000 sibling elements, whose children cannot be passed as call arguments', async () => {
    const result = await build(`<template>${'<i></i>'.repeat(150_000)}</template>`, '');
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
  }, 60_000);
});
