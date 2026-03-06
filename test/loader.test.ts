import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import type { Story, Diagnostic } from '../src/types.js';
import { createStory } from '../src/story.js';
import { loadSources, loadInlineSources } from '../src/loader.js';

const TMP_DIR = join(__dirname, '__tmp_loader__');

function freshStory(): Story {
  return createStory();
}

describe('loadSources', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('loads .tw files as passages', () => {
    const file = join(TMP_DIR, 'story.tw');
    writeFileSync(file, ':: Start\nHello world');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('loads .twee2 files with twee2 compat', () => {
    const file = join(TMP_DIR, 'story.twee2');
    writeFileSync(file, ':: Start\nHello');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('loads .css files as stylesheet passages', () => {
    const file = join(TMP_DIR, 'style.css');
    writeFileSync(file, 'body { color: red; }');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('stylesheet'))).toBe(true);
  });

  it('loads .js files as script passages', () => {
    const file = join(TMP_DIR, 'script.js');
    writeFileSync(file, 'console.log("hi")');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('script'))).toBe(true);
  });

  it('loads image files as Twine.image passages', () => {
    const file = join(TMP_DIR, 'photo.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    const passage = story.passages.find((p) => p.tags.includes('Twine.image'));
    expect(passage).toBeDefined();
    expect(passage!.text).toContain('data:image/png;base64,');
  });

  it('loads audio files as Twine.audio passages', () => {
    const file = join(TMP_DIR, 'sound.mp3');
    writeFileSync(file, Buffer.from([0xff, 0xfb]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('Twine.audio'))).toBe(true);
  });

  it('loads video files as Twine.video passages', () => {
    const file = join(TMP_DIR, 'clip.mp4');
    writeFileSync(file, Buffer.from([0x00, 0x00]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('Twine.video'))).toBe(true);
  });

  it('loads vtt files as Twine.vtt passages', () => {
    const file = join(TMP_DIR, 'subs.vtt');
    writeFileSync(file, 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages.some((p) => p.tags.includes('Twine.vtt'))).toBe(true);
  });

  it('loads font files as stylesheet passages with @font-face', () => {
    const file = join(TMP_DIR, 'myfont.ttf');
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x00, 0x00]));
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    const passage = story.passages.find((p) => p.name === 'myfont.ttf');
    expect(passage).toBeDefined();
    expect(passage!.text).toContain('@font-face');
    expect(passage!.text).toContain('font-family: "myfont"');
  });

  it('warns on duplicate files', () => {
    const file = join(TMP_DIR, 'dup.tw');
    writeFileSync(file, ':: Start\nHello');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    const processed = new Set<string>();
    loadSources(story, [file, file], { trim: true }, diag, processed);
    expect(diag.some((d) => d.message.includes('Skipping duplicate'))).toBe(true);
  });

  it('skips unknown file types', () => {
    const file = join(TMP_DIR, 'data.json');
    writeFileSync(file, '{}');
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [file], {}, diag, new Set());
    expect(story.passages).toHaveLength(0);
  });

  it('collects error diagnostics for unreadable files', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadSources(story, [join(TMP_DIR, 'missing.tw')], { trim: true }, diag, new Set());
    expect(diag.some((d) => d.level === 'error')).toBe(true);
  });

  it('prepends StoryTitle if story has a name but no StoryTitle passage', () => {
    const file = join(TMP_DIR, 'named.tw');
    writeFileSync(file, ':: Start\nContent');
    const story = freshStory();
    story.name = 'My Story';
    const diag: Diagnostic[] = [];
    loadSources(story, [file], { trim: true }, diag, new Set());
    expect(story.passages[0].name).toBe('StoryTitle');
    expect(story.passages[0].text).toBe('My Story');
  });
});

describe('loadInlineSources', () => {
  it('parses inline twee content', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(
      story,
      [{ filename: 'inline.tw', content: ':: Start\nHello from inline!' }],
      { trim: true },
      diag,
    );
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('handles Buffer content', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(
      story,
      [{ filename: 'buf.tw', content: Buffer.from(':: Start\nFrom buffer') }],
      { trim: true },
      diag,
    );
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('treats .twee2 inline sources with twee2 compat', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'old.twee2', content: ':: Start\nTwee2 content' }], { trim: true }, diag);
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('parses inline sources without extension as twee', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(story, [{ filename: 'noext', content: ':: Start\nNo ext' }], { trim: true }, diag);
    expect(story.passages.some((p) => p.name === 'Start')).toBe(true);
  });

  it('skips string sources (file paths handled externally)', () => {
    const story = freshStory();
    const diag: Diagnostic[] = [];
    loadInlineSources(story, ['some/path.tw'], { trim: true }, diag);
    expect(story.passages).toHaveLength(0);
  });
});
