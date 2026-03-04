import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { discoverFormats, getFormatIdByName, getFormatIdByNameAndVersion } from '../src/formats.js';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'storyformats');

describe('discoverFormats', () => {
  it('discovers formats in the fixtures directory', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    expect(formats.size).toBeGreaterThanOrEqual(1);
    expect(formats.has('test-format-1')).toBe(true);

    const tf = formats.get('test-format-1')!;
    expect(tf.name).toBe('Test Format');
    expect(tf.version).toBe('1.0.0');
    expect(tf.isTwine2).toBe(true);
  });

  it('returns empty map for nonexistent directory', () => {
    const formats = discoverFormats(['/nonexistent/path']);
    expect(formats.size).toBe(0);
  });
});

describe('getFormatIdByName', () => {
  it('finds format by Twine 2 name', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    const id = getFormatIdByName(formats, 'Test Format');
    expect(id).toBe('test-format-1');
  });

  it('returns undefined for unknown format', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    const id = getFormatIdByName(formats, 'Unknown Format');
    expect(id).toBeUndefined();
  });
});

describe('getFormatIdByNameAndVersion', () => {
  it('finds format matching major version', () => {
    const formats = discoverFormats([FIXTURES_DIR]);
    const id = getFormatIdByNameAndVersion(formats, 'Test Format', '1.0.0');
    expect(id).toBe('test-format-1');
  });
});
