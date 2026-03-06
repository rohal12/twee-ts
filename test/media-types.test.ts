import { describe, it, expect } from 'vitest';
import {
  mediaTypeFromExt,
  mediaTypeFromFilename,
  normalizedFileExt,
  slugify,
  isKnownFileType,
  fontFormatHint,
} from '../src/media-types.js';

describe('normalizedFileExt', () => {
  it('returns lowercase extension without dot', () => {
    expect(normalizedFileExt('image.PNG')).toBe('png');
    expect(normalizedFileExt('style.CSS')).toBe('css');
  });

  it('returns empty string for files without extension', () => {
    expect(normalizedFileExt('Makefile')).toBe('');
  });

  it('handles dotfiles as having no name, only ext', () => {
    expect(normalizedFileExt('.gitignore')).toBe('');
  });

  it('returns only the last extension', () => {
    expect(normalizedFileExt('archive.tar.gz')).toBe('gz');
  });
});

describe('mediaTypeFromExt', () => {
  it('returns correct MIME types for audio', () => {
    expect(mediaTypeFromExt('mp3')).toBe('audio/mpeg');
    expect(mediaTypeFromExt('ogg')).toBe('audio/ogg');
    expect(mediaTypeFromExt('wav')).toBe('audio/wav');
    expect(mediaTypeFromExt('flac')).toBe('audio/flac');
    expect(mediaTypeFromExt('aac')).toBe('audio/aac');
    expect(mediaTypeFromExt('m4a')).toBe('audio/mp4');
    expect(mediaTypeFromExt('oga')).toBe('audio/ogg');
    expect(mediaTypeFromExt('opus')).toBe('audio/ogg');
    expect(mediaTypeFromExt('wave')).toBe('audio/wav');
    expect(mediaTypeFromExt('weba')).toBe('audio/webm');
  });

  it('returns correct MIME types for fonts', () => {
    expect(mediaTypeFromExt('otf')).toBe('font/otf');
    expect(mediaTypeFromExt('ttf')).toBe('font/ttf');
    expect(mediaTypeFromExt('woff')).toBe('font/woff');
    expect(mediaTypeFromExt('woff2')).toBe('font/woff2');
  });

  it('returns correct MIME types for images', () => {
    expect(mediaTypeFromExt('gif')).toBe('image/gif');
    expect(mediaTypeFromExt('jpeg')).toBe('image/jpeg');
    expect(mediaTypeFromExt('jpg')).toBe('image/jpeg');
    expect(mediaTypeFromExt('png')).toBe('image/png');
    expect(mediaTypeFromExt('svg')).toBe('image/svg+xml');
    expect(mediaTypeFromExt('tif')).toBe('image/tiff');
    expect(mediaTypeFromExt('tiff')).toBe('image/tiff');
    expect(mediaTypeFromExt('webp')).toBe('image/webp');
  });

  it('returns correct MIME types for video', () => {
    expect(mediaTypeFromExt('mp4')).toBe('video/mp4');
    expect(mediaTypeFromExt('ogv')).toBe('video/ogg');
    expect(mediaTypeFromExt('webm')).toBe('video/webm');
  });

  it('returns correct MIME type for metadata', () => {
    expect(mediaTypeFromExt('vtt')).toBe('text/vtt');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(mediaTypeFromExt('xyz')).toBe('application/octet-stream');
    expect(mediaTypeFromExt('')).toBe('application/octet-stream');
  });
});

describe('mediaTypeFromFilename', () => {
  it('derives MIME type from filename', () => {
    expect(mediaTypeFromFilename('song.mp3')).toBe('audio/mpeg');
    expect(mediaTypeFromFilename('photo.PNG')).toBe('image/png');
    expect(mediaTypeFromFilename('font.woff2')).toBe('font/woff2');
  });

  it('returns octet-stream for extensionless files', () => {
    expect(mediaTypeFromFilename('README')).toBe('application/octet-stream');
  });
});

describe('slugify', () => {
  it('replaces special characters with underscores', () => {
    expect(slugify('Hello World!')).toBe('Hello_World_');
  });

  it('replaces runs of control and punctuation characters', () => {
    expect(slugify('a/b:c@d')).toBe('a_b_c_d');
  });

  it('leaves alphanumerics and extended chars intact', () => {
    expect(slugify('café')).toBe('café');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('isKnownFileType', () => {
  it('recognizes twee files', () => {
    expect(isKnownFileType('story.tw')).toBe(true);
    expect(isKnownFileType('story.twee')).toBe(true);
    expect(isKnownFileType('old.tw2')).toBe(true);
    expect(isKnownFileType('old.twee2')).toBe(true);
  });

  it('recognizes asset files', () => {
    expect(isKnownFileType('style.css')).toBe(true);
    expect(isKnownFileType('app.js')).toBe(true);
    expect(isKnownFileType('font.woff2')).toBe(true);
    expect(isKnownFileType('photo.jpg')).toBe(true);
    expect(isKnownFileType('song.mp3')).toBe(true);
    expect(isKnownFileType('video.mp4')).toBe(true);
    expect(isKnownFileType('subs.vtt')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isKnownFileType('readme.md')).toBe(false);
    expect(isKnownFileType('data.json')).toBe(false);
    expect(isKnownFileType('Makefile')).toBe(false);
  });
});

describe('fontFormatHint', () => {
  it('returns truetype for ttf', () => {
    expect(fontFormatHint('ttf')).toBe('truetype');
  });

  it('returns opentype for otf', () => {
    expect(fontFormatHint('otf')).toBe('opentype');
  });

  it('returns the extension itself for woff/woff2', () => {
    expect(fontFormatHint('woff')).toBe('woff');
    expect(fontFormatHint('woff2')).toBe('woff2');
  });
});
