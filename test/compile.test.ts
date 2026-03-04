import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

describe('compile', () => {
  it('compiles a minimal twee file to HTML', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('<html>');
    expect(result.output).toContain('Minimal Story');
    expect(result.output).toContain('tw-storydata');
    expect(result.output).toContain('Hello, world!');
    expect(result.stats.passages).toBeGreaterThan(0);
  });

  it('compiles multi-passage file', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('tw-passagedata');
    expect(result.output).toContain('Room');
    expect(result.output).toContain('Secret Room');
    expect(result.stats.passages).toBeGreaterThanOrEqual(5);
  });

  it('compiles to Twee3 output', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'twee3',
    });

    expect(result.output).toContain(':: Start');
    expect(result.output).toContain(':: Room [location]');
    expect(result.output).toContain(':: Secret Room [location hidden]');
  });

  it('compiles to JSON output', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      outputMode: 'json',
    });

    const json = JSON.parse(result.output);
    expect(json.name).toBe('A Story With Metadata');
    expect(json.ifid).toBe('D674C58C-DEFA-4F70-B7A2-27742230C0FC');
    expect(json.passages.length).toBeGreaterThan(0);
  });

  it('supports inline sources', async () => {
    const result = await compile({
      sources: [
        { filename: 'inline.tw', content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: StoryTitle\nInline Story\n\n:: Start\nHello from inline!' },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('Hello from inline!');
    expect(result.output).toContain('Inline Story');
  });

  it('compiles to Twine 2 archive', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'minimal.tw')],
      outputMode: 'twine2-archive',
    });

    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
    expect(result.output).not.toContain('<html>');
  });

  it('preserves story metadata', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      outputMode: 'json',
    });

    const json = JSON.parse(result.output);
    expect(json.twine2.format).toBe('SugarCube');
    expect(json.twine2.formatVersion).toBe('2.37.3');
    expect(json.twine2.start).toBe('Begin');
    expect(json.twine2.tagColors).toEqual({ location: 'green', character: 'blue' });
  });

  it('reports diagnostics rather than throwing', async () => {
    const result = await compile({
      sources: [{ filename: 'broken.tw', content: ':: Test [unclosed\nContent' }],
      outputMode: 'twee3',
    });

    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('treats aliased tag as script in Twine 2 HTML', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'alias.tw',
          content: [
            ':: StoryData',
            '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
            '',
            ':: StoryTitle',
            'Alias Test',
            '',
            ':: Start',
            'Hello',
            '',
            ':: MyLib [library]',
            'window.myLib = true;',
          ].join('\n'),
        },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      tagAliases: { library: 'script' },
    });

    // Library passage should be in the script block, not as passagedata
    expect(result.output).toContain('id="twine-user-script"');
    expect(result.output).toContain('window.myLib = true;');
    // Should NOT appear as a regular passage
    expect(result.output).not.toContain('name="MyLib"');
  });

  it('treats aliased tag as stylesheet in Twine 2 HTML', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'alias-css.tw',
          content: [
            ':: StoryData',
            '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
            '',
            ':: StoryTitle',
            'CSS Alias Test',
            '',
            ':: Start',
            'Hello',
            '',
            ':: Theme [theme]',
            'body { color: red; }',
          ].join('\n'),
        },
      ],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
      tagAliases: { theme: 'stylesheet' },
    });

    expect(result.output).toContain('id="twine-user-stylesheet"');
    expect(result.output).toContain('body { color: red; }');
    expect(result.output).not.toContain('name="Theme"');
  });

  it('handles passage position metadata in output', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });

    expect(result.output).toContain('position="100,100"');
    expect(result.output).toContain('size="200,100"');
  });
});
