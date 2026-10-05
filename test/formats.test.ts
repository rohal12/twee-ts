import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverFormats,
  getFormatIdByName,
  getFormatIdByNameAndVersion,
  makeFormatId,
  parseFormatJSON,
  selectFormatCandidate,
} from '../src/formats.js';
import type { FormatRequest } from '../src/types.js';

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

describe('parseFormatJSON with a Harlowe setup function', () => {
  const HARLOWE_DIR = join(__dirname, 'fixtures', 'storyformats-harlowe');
  const source = readFileSync(join(HARLOWE_DIR, 'harlowe-3', 'format.js'), 'utf-8');

  it('parses the same bytes regardless of the format ID it is given', () => {
    for (const id of ['harlowe-3', 'direct-url', 'anything']) {
      const data = parseFormatJSON(source, id);
      expect(data?.name).toBe('Harlowe');
      expect(data?.version).toBe('3.3.9');
      expect(data?.source).toContain('{{STORY_DATA}}');
    }
  });

  it('discovers the format from a local directory', () => {
    const formats = discoverFormats([HARLOWE_DIR]);
    expect(formats.get('harlowe-3')?.name).toBe('Harlowe');
  });

  it('still rejects source that is not a format', () => {
    expect(parseFormatJSON('window.storyFormat({"name":"X", "setup": function(){}});', 'harlowe-3')).toBeNull();
  });
});

describe('makeFormatId', () => {
  it('builds a directory-style ID from a name and version', () => {
    expect(makeFormatId('SugarCube', '2.37.3')).toBe('sugarcube-2');
    expect(makeFormatId('Test  Format', '1.0.0')).toBe('test-format-1');
  });
});

describe('selectFormatCandidate', () => {
  const candidates = [
    { name: 'SugarCube', version: '2.36.1' },
    { name: 'SugarCube', version: '2.37.3' },
    { name: 'SugarCube', version: '1.0.35' },
    { name: 'Harlowe', version: '3.3.9' },
  ] as const;
  const select = (request: FormatRequest, allowOlder = false) =>
    selectFormatCandidate(request, candidates, (c) => c, { allowOlder })?.version;

  it('prefers an exact version, then the highest same-major version at or above it', () => {
    expect(select({ kind: 'name', name: 'SugarCube', version: '2.36.1' })).toBe('2.36.1');
    expect(select({ kind: 'name', name: 'sugarcube', version: '2.30.0' })).toBe('2.37.3');
    expect(select({ kind: 'name', name: 'SugarCube', version: '2.38.0' })).toBeUndefined();
    expect(select({ kind: 'name', name: 'SugarCube', version: '3.0.0' })).toBeUndefined();
  });

  it('takes the highest version of any major when the version is unparseable', () => {
    expect(select({ kind: 'name', name: 'SugarCube', version: '' })).toBe('2.37.3');
  });

  it('matches IDs by name and major', () => {
    expect(select({ kind: 'id', id: 'sugarcube-2' })).toBe('2.37.3');
    expect(select({ kind: 'id', id: 'sugarcube-1' })).toBe('1.0.35');
    expect(select({ kind: 'id', id: 'harlowe-3' })).toBe('3.3.9');
    expect(select({ kind: 'id', id: 'harlowe-2' })).toBeUndefined();
  });

  it('allows an older same-major version only when asked', () => {
    expect(select({ kind: 'name', name: 'SugarCube', version: '2.38.0' }, true)).toBe('2.37.3');
    expect(select({ kind: 'name', name: 'SugarCube', version: '3.0.0' }, true)).toBeUndefined();
  });
});
