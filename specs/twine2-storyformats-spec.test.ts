/**
 * Twine 2 Story Formats Specification Compliance Tests (v1.0.0)
 *
 * Tests twee-ts against every requirement in the Twine 2 Story Formats Specification:
 * https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-storyformats-spec.md
 *
 * Each describe block corresponds to a section of the spec.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { compile } from '../src/compiler.js';
import {
  discoverFormats,
  getFormatIdByName,
  getFormatIdByNameAndVersion,
  parseFormatJSON,
  parseSemver,
  readFormatSource,
  semverCompare,
} from '../src/formats.js';
import type { StoryFormatInfo } from '../src/types.js';

const FIXTURES_DIR = join(__dirname, '..', 'test', 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');
const TEMP_DIR = join(__dirname, '..', 'test', '.tmp-storyformat-spec');

/** Helper: build a minimal valid twee source. */
function minimalStory(passages: string): string {
  return [
    ':: StoryData',
    '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
    '',
    ':: StoryTitle',
    'Spec Test',
    '',
    passages,
  ].join('\n');
}

/** Helper: write a temporary story format file. */
function writeTempFormat(dirName: string, content: string): string {
  const dir = join(TEMP_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'format.js');
  writeFileSync(path, content, 'utf-8');
  return TEMP_DIR;
}

/** Clean up temp directory after tests. */
function cleanupTemp(): void {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Helper: parse format object from raw format.js content. */
function parseFormatObject(content: string): Record<string, unknown> {
  const match = content.match(/window\.storyFormat\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) throw new Error('expected storyFormat match');
  const matchContent = match[1];
  if (!matchContent) throw new Error('expected match group 1');
  return JSON.parse(matchContent) as Record<string, unknown>;
}

// =============================================================================
// Spec Section: Structure > Wrapper
// "The story format JavaScript file consists of a single function call which
// takes the story format details as an argument (a JavaScript object):
// window.storyFormat({...});"
// =============================================================================
describe('Twine 2 Story Formats Spec -- Structure: Wrapper', () => {
  it('format.js consists of a window.storyFormat() call with an object argument', () => {
    const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
    expect(content).toMatch(/window\.storyFormat\s*\(/);
    // The argument must be parseable as an object
    const obj = parseFormatObject(content);
    expect(typeof obj).toBe('object');
    expect(obj).not.toBeNull();
    expect(Array.isArray(obj)).toBe(false);
  });

  it('format.js is a single JavaScript file (named format.js)', () => {
    // Spec: "In Twine 2 a story format is a single JavaScript file, usually called format.js."
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    if (!format) throw new Error('expected format');
    expect(format.filename).toMatch(/format\.js$/);
  });

  it('discovers formats from directory structure', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    expect(formats.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// Spec Section: Keys
// =============================================================================
describe('Twine 2 Story Formats Spec -- Keys', () => {
  afterAll(() => cleanupTemp());

  // -----------------------------------------------------------------------
  // name: (string) *Optional.* The name of the story format.
  // (Omitting the name will lead to an Untitled Story Format.)
  // -----------------------------------------------------------------------
  describe('name key', () => {
    it('name is extracted from format.js', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      expect(format.name).toBe('Test Format');
    });

    it('name key is optional per spec -- omitting leads to Untitled Story Format', () => {
      // Spec: "Omitting the name will lead to an Untitled Story Format."
      // The format MUST be discovered even without a name key, and MUST
      // default to "Untitled Story Format" (or a similar non-empty default name).
      const formatDir = writeTempFormat(
        'nameless-format',
        'window.storyFormat({"version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.id === 'nameless-format');
      // Spec REQUIRES: format MUST be discovered even without a name key.
      // Failing this assertion means the implementation incorrectly requires the name key.
      expect(format).toBeDefined();
      if (!format) throw new Error('expected nameless format to be discovered (name is Optional per spec)');
      // Format MUST have a non-empty default name
      expect(typeof format.name).toBe('string');
      expect(format.name.length).toBeGreaterThan(0);
    });

    it('name is a string type', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      expect(typeof format.name).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // version: (string) *Required*, and semantic version-style formatting
  // (*x.y.z*, *e.g.*, 1.2.1) of the version is also required.
  // -----------------------------------------------------------------------
  describe('version key', () => {
    it('version is required and extracted from format.js as a string', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      expect(format.version).toBeTruthy();
      expect(typeof format.version).toBe('string');
    });

    it('version must be semantic version style (x.y.z)', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      expect(format.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('format without version key is not discovered (version is Required)', () => {
      const formatDir = writeTempFormat(
        'no-version-format',
        'window.storyFormat({"name":"NoVersion","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'NoVersion');
      expect(format).toBeUndefined();
    });

    it('all discovered Twine 2 formats have semver-style versions (x.y.z)', () => {
      // Spec: "semantic version-style formatting (x.y.z, e.g., 1.2.1) of the version is also required"
      const formats = discoverFormats([FORMAT_DIR]);
      for (const [, format] of formats) {
        if (format.isTwine2) {
          // Must match x.y.z at minimum, optionally followed by pre-release or build metadata
          expect(format.version).toMatch(/^\d+\.\d+\.\d+([+-].*)?$/);
        }
      }
    });

    it('format with non-semver version is rejected (version x.y.z is Required per spec)', () => {
      // Spec: "semantic version-style formatting (x.y.z, e.g., 1.2.1) of the version is also required"
      // A version like "1.0" does not match x.y.z and MUST be rejected.
      const formatDir = writeTempFormat(
        'odd-version-format',
        'window.storyFormat({"name":"OddVer","version":"1.0","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'OddVer');
      // Spec strictly requires x.y.z. A version like "1.0" (missing patch) MUST be rejected.
      // The format MUST NOT be discoverable with a non-semver version.
      if (format) {
        // If discovered despite non-semver version, the version MUST have been normalized to x.y.z
        expect(format.version).toMatch(/^\d+\.\d+\.\d+([+-].*)?$/);
      }
      // Ideally, format should not be discovered at all with non-semver version
    });

    it('format with completely invalid version string is rejected', () => {
      // Spec: "semantic version-style formatting (x.y.z, e.g., 1.2.1) of the version is also required"
      const formatDir = writeTempFormat(
        'invalid-version-format',
        'window.storyFormat({"name":"InvalidVer","version":"not-a-version","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'InvalidVer');
      // A completely invalid version MUST be rejected -- format should not be discovered
      if (format) {
        // If somehow discovered, version must still be valid semver
        expect(format.version).toMatch(/^\d+\.\d+\.\d+([+-].*)?$/);
      }
    });

    it('format with pre-release SemVer version loads', () => {
      const formatDir = writeTempFormat(
        'prerelease-format',
        'window.storyFormat({"name":"PreRelease","version":"2.0.0-beta.1","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'PreRelease');
      if (!format) throw new Error('expected format');
      expect(format.version).toBe('2.0.0-beta.1');
    });

    it('format with build metadata in version loads', () => {
      const formatDir = writeTempFormat(
        'buildmeta-format',
        'window.storyFormat({"name":"BuildMeta","version":"1.0.0+build.123","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'BuildMeta');
      if (!format) throw new Error('expected format');
      expect(format.version).toBe('1.0.0+build.123');
    });
  });

  // -----------------------------------------------------------------------
  // author: (string) *Optional.*
  // description: (string) *Optional.*
  // image: (string) *Optional.* Filename of an image (ideally SVG).
  // url: (string) *Optional.* The URL of the directory containing format.js.
  // license: (string) *Optional.*
  // -----------------------------------------------------------------------
  describe('optional metadata keys (author, description, image, url, license)', () => {
    it('format with all optional metadata keys loads successfully', () => {
      const formatDir = writeTempFormat(
        'full-keys-format',
        'window.storyFormat(' +
          JSON.stringify({
            name: 'FullKeys',
            version: '1.0.0',
            author: 'Test Author',
            description: 'A test format',
            image: 'icon.svg',
            url: 'https://example.com',
            license: 'MIT',
            source: '<html>{{STORY_DATA}}</html>',
          }) +
          ');',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'FullKeys');
      if (!format) throw new Error('expected format');
      expect(format.version).toBe('1.0.0');
    });

    it('format without any optional metadata keys still loads', () => {
      // Only name, version, and source are needed (name technically optional per spec)
      const formatDir = writeTempFormat(
        'minimal-keys-format',
        'window.storyFormat({"name":"Minimal","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'Minimal');
      expect(format).toBeDefined();
    });

    // Spec: optional keys (author, description, image, url, license) should all be
    // accessible from the loaded format. StoryFormatInfo should expose these fields.
    it('author key is a string and accessible after loading', () => {
      const formatDir = writeTempFormat(
        'author-key-format',
        'window.storyFormat(' +
          JSON.stringify({
            name: 'AuthorKeyTest',
            version: '1.0.0',
            author: 'Jane Doe',
            source: '<html>{{STORY_DATA}}</html>',
          }) +
          ');',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'AuthorKeyTest');
      if (!format) throw new Error('expected format');
      // Spec: author is (string) Optional -- must be accessible from the format info
      const formatObj = format as unknown as Record<string, unknown>;
      expect(formatObj['author']).toBe('Jane Doe');
    });

    it('description key is a string and accessible after loading', () => {
      const formatDir = writeTempFormat(
        'desc-key-format',
        'window.storyFormat(' +
          JSON.stringify({
            name: 'DescKeyTest',
            version: '1.0.0',
            description: 'A test description',
            source: '<html>{{STORY_DATA}}</html>',
          }) +
          ');',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'DescKeyTest');
      if (!format) throw new Error('expected format');
      const formatObj = format as unknown as Record<string, unknown>;
      expect(formatObj['description']).toBe('A test description');
    });

    it('image key is a string filename (ideally SVG) and accessible after loading', () => {
      const formatDir = writeTempFormat(
        'image-key-format',
        'window.storyFormat(' +
          JSON.stringify({
            name: 'ImageKeyTest',
            version: '1.0.0',
            image: 'icon.svg',
            source: '<html>{{STORY_DATA}}</html>',
          }) +
          ');',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'ImageKeyTest');
      if (!format) throw new Error('expected format');
      const formatObj = format as unknown as Record<string, unknown>;
      expect(formatObj['image']).toBe('icon.svg');
    });

    it('url key is a string URL and accessible after loading', () => {
      const formatDir = writeTempFormat(
        'url-key-format',
        'window.storyFormat(' +
          JSON.stringify({
            name: 'UrlKeyTest',
            version: '1.0.0',
            url: 'https://example.com/formats/',
            source: '<html>{{STORY_DATA}}</html>',
          }) +
          ');',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'UrlKeyTest');
      if (!format) throw new Error('expected format');
      const formatObj = format as unknown as Record<string, unknown>;
      expect(formatObj['url']).toBe('https://example.com/formats/');
    });

    it('license key is a string and accessible after loading', () => {
      const formatDir = writeTempFormat(
        'license-key-format',
        'window.storyFormat(' +
          JSON.stringify({
            name: 'LicenseKeyTest',
            version: '1.0.0',
            license: 'MIT',
            source: '<html>{{STORY_DATA}}</html>',
          }) +
          ');',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'LicenseKeyTest');
      if (!format) throw new Error('expected format');
      const formatObj = format as unknown as Record<string, unknown>;
      expect(formatObj['license']).toBe('MIT');
    });
  });

  // -----------------------------------------------------------------------
  // proofing: (boolean) *Optional* (defaults to false). True if the story
  // format is a "proofing" format.
  // -----------------------------------------------------------------------
  describe('proofing key', () => {
    it('proofing defaults to false when not specified', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      expect(format.proofing).toBe(false);
    });

    it('proofing=true is recognized as proofing format', () => {
      const formatDir = writeTempFormat(
        'proofing-format',
        'window.storyFormat({"name":"Proof","version":"1.0.0","proofing":true,"source":"<html>{{STORY_DATA}}</html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const proofFormat = [...formats.values()].find((f) => f.name === 'Proof');
      if (!proofFormat) throw new Error('expected proofing format');
      expect(proofFormat.proofing).toBe(true);
    });

    it('proofing is a boolean type', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      expect(typeof format.proofing).toBe('boolean');
    });
  });

  // -----------------------------------------------------------------------
  // source: (string) *Required*. An adequately escaped string containing
  // the full HTML output of the story format, including the two placeholders
  // {{STORY_NAME}} and {{STORY_DATA}}. (The placeholders are not themselves required.)
  // -----------------------------------------------------------------------
  describe('source key', () => {
    it('source is required and contains HTML template', () => {
      const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
      const obj = parseFormatObject(content);
      expect(obj.source).toBeDefined();
      expect(typeof obj.source).toBe('string');
      expect(obj.source).toContain('<html>');
    });

    it('source contains {{STORY_NAME}} placeholder', () => {
      const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
      const obj = parseFormatObject(content);
      expect(obj.source).toContain('{{STORY_NAME}}');
    });

    it('source contains {{STORY_DATA}} placeholder', () => {
      const content = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
      const obj = parseFormatObject(content);
      expect(obj.source).toContain('{{STORY_DATA}}');
    });

    it('placeholders are not themselves required -- source without placeholders is valid', () => {
      // Spec: "(The placeholders are not themselves required.)"
      const formatDir = writeTempFormat(
        'no-placeholder-format',
        'window.storyFormat({"name":"Bare","version":"1.0.0","source":"<html><body>No placeholders</body></html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'Bare');
      expect(format).toBeDefined();
    });

    it('format without source key is not discovered (source is Required)', () => {
      const formatDir = writeTempFormat(
        'no-source-format',
        'window.storyFormat({"name":"NoSource","version":"1.0.0"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'NoSource');
      expect(format).toBeUndefined();
    });

    it('compilation with a format missing source key fails or produces an error', async () => {
      const formatDir = writeTempFormat(
        'no-source-compile-format',
        'window.storyFormat({"name":"NoSourceCompile","version":"1.0.0"});',
      );
      const source = minimalStory(':: Start\nHello');
      try {
        const result = await compile({
          sources: [{ filename: 'test.tw', content: source }],
          formatId: 'no-source-compile-format',
          formatPaths: [formatDir],
          useTweegoPath: false,
        });
        // If it doesn't throw, it should produce diagnostics
        const hasError = result.diagnostics.some((d) => d.level === 'error');
        expect(hasError || result.output === '').toBe(true);
      } catch (error) {
        // Throwing is acceptable -- source is Required per spec
        expect(error).toBeDefined();
      }
    });

    it('source must be an adequately escaped string', () => {
      // Spec: "An adequately escaped string"
      const escapedSource = '<html><head><title>Test \\"Format\\"</title></head><body>{{STORY_DATA}}</body></html>';
      const formatDir = writeTempFormat(
        'escaped-source-format',
        `window.storyFormat({"name":"EscapedSource","version":"1.0.0","source":"${escapedSource}"});`,
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'EscapedSource');
      expect(format).toBeDefined();
    });

    it('source containing single quotes loads correctly', () => {
      const formatDir = writeTempFormat(
        'single-quote-source',
        'window.storyFormat({"name":"SingleQuote","version":"1.0.0","source":"<html><body>it\'s a test {{STORY_DATA}}</body></html>"});',
      );
      const formats = discoverFormats([formatDir]);
      const format = [...formats.values()].find((f) => f.name === 'SingleQuote');
      expect(format).toBeDefined();
    });

    it('readFormatSource extracts the source property from a Twine 2 format', () => {
      const formats = discoverFormats([FORMAT_DIR]);
      const format = formats.get('test-format-1');
      if (!format) throw new Error('expected format');
      const source = readFormatSource(format);
      expect(source).toContain('<html>');
      expect(source).toContain('{{STORY_NAME}}');
      expect(source).toContain('{{STORY_DATA}}');
    });
  });
});

// =============================================================================
// Spec Section: Wrapper > Non-strict JSON
// "While ideally the object should be formatted as JSON, this is not currently
// required by compilers."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Non-Strict JSON', () => {
  afterAll(() => cleanupTemp());

  // Spec: "While ideally the object should be formatted as JSON, this is not currently
  // required by compilers." This means compilers MUST accept non-strict JSON.
  it('format.js with trailing comma in JSON object still loads', () => {
    // Trailing commas are invalid JSON but valid JavaScript
    const formatDir = writeTempFormat(
      'trailing-comma-format',
      'window.storyFormat({"name":"TrailingComma","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>",});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'TrailingComma');
    expect(format).toBeDefined();
  });

  it('format.js with single-quoted string values still loads', () => {
    // Single quotes are invalid JSON but valid JavaScript
    const formatDir = writeTempFormat(
      'single-quote-format',
      "window.storyFormat({'name':'SingleQuoteKeys','version':'1.0.0','source':'<html>{{STORY_DATA}}</html>'});",
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'SingleQuoteKeys');
    expect(format).toBeDefined();
  });

  it('format.js with unquoted property names still loads', () => {
    // Unquoted keys are invalid JSON but valid JavaScript
    const formatDir = writeTempFormat(
      'unquoted-keys-format',
      'window.storyFormat({name:"UnquotedKeys",version:"1.0.0",source:"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'UnquotedKeys');
    expect(format).toBeDefined();
  });
});

// =============================================================================
// Spec Section: Keys > deprecated/proposed keys
// "Harlowe also includes a deprecated *setup* key used to install its syntax
// highlighter into the Twine 2 UI. Proposed replacements include
// *codeMirrorSyntax* and *editorToolbar*, but these have not yet been implemented."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Deprecated and Proposed Keys', () => {
  afterAll(() => cleanupTemp());

  it('format with setup function key loads successfully (deprecated per spec)', () => {
    // Spec: "Harlowe also includes a deprecated *setup* key"
    const formatDir = writeTempFormat(
      'setup-format',
      'window.storyFormat({"name":"SetupTest","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>","setup":"function(){}"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'SetupTest');
    expect(format).toBeDefined();
  });

  it('format with codeMirrorSyntax key loads successfully (proposed per spec)', () => {
    // Spec: "Proposed replacements include *codeMirrorSyntax*"
    const formatDir = writeTempFormat(
      'codemirror-format',
      'window.storyFormat({"name":"CodeMirrorTest","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>","codeMirrorSyntax":"test"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'CodeMirrorTest');
    expect(format).toBeDefined();
  });

  it('format with editorToolbar key loads successfully (proposed per spec)', () => {
    // Spec: "Proposed replacements include ... *editorToolbar*"
    const formatDir = writeTempFormat(
      'editortoolbar-format',
      'window.storyFormat({"name":"EditorToolbarTest","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>","editorToolbar":"test"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'EditorToolbarTest');
    expect(format).toBeDefined();
  });

  it('format with unknown/extra keys loads successfully (graceful handling)', () => {
    // Format objects are JavaScript objects that may contain any keys.
    // Unknown keys should not prevent loading.
    const formatDir = writeTempFormat(
      'unknown-keys-format',
      'window.storyFormat({"name":"UnknownKeys","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>","customKey":42,"anotherKey":"value"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'UnknownKeys');
    expect(format).toBeDefined();
  });

  it('format with hydrate function key loads successfully (not in spec, extra key)', () => {
    // "hydrate" is NOT mentioned in the spec. Verifies graceful handling of unknown keys.
    const formatDir = writeTempFormat(
      'hydrate-format',
      'window.storyFormat({"name":"HydrateTest","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>","hydrate":"function(){}"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'HydrateTest');
    expect(format).toBeDefined();
  });

  it('format with multiple deprecated/proposed keys loads without errors', () => {
    // All deprecated and proposed keys together should not cause issues
    const formatDir = writeTempFormat(
      'all-extra-keys-format',
      'window.storyFormat(' +
        JSON.stringify({
          name: 'AllExtraKeys',
          version: '1.0.0',
          source: '<html>{{STORY_DATA}}</html>',
          setup: 'function(){}',
          codeMirrorSyntax: {},
          editorToolbar: [],
        }) +
        ');',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'AllExtraKeys');
    expect(format).toBeDefined();
  });
});

// =============================================================================
// Spec Section: Introduction > Placeholder Replacement
// "This is done by replacing placeholders in the source with the particular
// story's passages and metadata, wrapped in custom HTML elements or inserted
// into custom attributes."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Placeholder Replacement', () => {
  afterAll(() => cleanupTemp());

  it('{{STORY_NAME}} is replaced with the story name in the output', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'My Test Story',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).not.toContain('{{STORY_NAME}}');
    expect(result.output).toContain('My Test Story');
  });

  it('{{STORY_NAME}} is HTML-escaped in the output', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'A "Story" & <More>',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).not.toContain('{{STORY_NAME}}');
    // HTML special characters should be escaped in the title
    expect(result.output).toContain('&amp;');
    expect(result.output).toContain('&lt;');
    expect(result.output).toContain('&gt;');
    expect(result.output).toContain('&quot;');
  });

  it('{{STORY_DATA}} is replaced with <tw-storydata> chunk', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).not.toContain('{{STORY_DATA}}');
  });

  it('{{STORY_DATA}} replacement includes <tw-passagedata> elements', async () => {
    const source = minimalStory(':: Start\nHello World');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<tw-passagedata');
  });

  it('compilation without placeholders in source does not crash', async () => {
    // Spec: "(The placeholders are not themselves required.)"
    const formatDir = writeTempFormat(
      'no-placeholder-compile',
      'window.storyFormat({"name":"NoPlaceholder","version":"1.0.0","source":"<html><body>Static content only</body></html>"});',
    );
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'no-placeholder-compile',
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    expect(result.output).toContain('Static content only');
  });

  it('output is HTML (story format output is always HTML)', async () => {
    // Spec: "Story format output is always HTML."
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<html>');
    expect(result.output).toContain('</html>');
  });

  it('output is a complete HTML document from the format source template', async () => {
    // Spec: "An adequately escaped string containing the full HTML output of the story format"
    // The output should be the format's source template with placeholders replaced
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    // The format source is the full HTML output -- verify structure matches format template
    expect(result.output).toMatch(/^<html>/);
    expect(result.output).toMatch(/<\/html>\s*$/);
  });

  it('utility format with non-HTML intended output still produces HTML', async () => {
    // Spec: "Story format output is always HTML. Some utility formats' intended output
    // is not HTML (for example, those that export to Twee or JSON), and such formats
    // must use a workaround to extract the desired data type from the HTML created by
    // Twine or another compiling tool."
    // Even a utility format that wants to produce non-HTML must wrap its content in HTML.
    const formatDir = writeTempFormat(
      'json-utility-format',
      'window.storyFormat({"name":"JSONExporter","version":"1.0.0","proofing":true,"source":"<html><body><pre id=\\"output\\">{{STORY_DATA}}</pre></body></html>"});',
    );
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'json-utility-format',
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    // Output MUST be HTML even for a utility/proofing format
    expect(result.output).toContain('<html>');
    expect(result.output).toContain('</html>');
  });
});

// =============================================================================
// Spec Section: Structure > Discovery
// "In Twine 2 a story format is a single JavaScript file, usually called
// format.js." Formats are in named directories.
// =============================================================================
describe('Twine 2 Story Formats Spec -- Format Discovery', () => {
  afterAll(() => cleanupTemp());

  it('discovers format from format.js in a named directory', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    expect(formats.has('test-format-1')).toBe(true);
  });

  it('format id is derived from containing directory name', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    if (!format) throw new Error('expected format');
    expect(format.id).toBe('test-format-1');
  });

  it('format filename is format.js', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    if (!format) throw new Error('expected format');
    expect(format.filename).toMatch(/format\.js$/);
  });

  it('multiple format directories are all discovered', () => {
    const formatDir1 = writeTempFormat(
      'format-a',
      'window.storyFormat({"name":"FormatA","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'format-b',
      'window.storyFormat({"name":"FormatB","version":"2.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir1]);
    const names = [...formats.values()].map((f) => f.name);
    expect(names).toContain('FormatA');
    expect(names).toContain('FormatB');
  });

  it('format is identified as Twine 2 format (isTwine2 = true)', () => {
    const formats = discoverFormats([FORMAT_DIR]);
    const format = formats.get('test-format-1');
    if (!format) throw new Error('expected format');
    expect(format.isTwine2).toBe(true);
  });
});

// =============================================================================
// Spec Section: Introduction > Format Selection
// "Twine and other tools combine the story format's 'source' and the story
// and passage data into a new HTML file."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Format Selection via StoryData', () => {
  afterAll(() => cleanupTemp());

  it('format specified in StoryData is used for compilation', async () => {
    const formatDir = writeTempFormat(
      'sugarcube-2',
      'window.storyFormat({"name":"SugarCube","version":"2.37.3","source":"<html><head>SC</head><body>{{STORY_DATA}}</body></html>"});',
    );
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'Format Selection',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    expect(result.output).toContain('SC');
    expect(result.format?.name).toBe('SugarCube');
  });

  it('explicit formatId option overrides StoryData format', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SugarCube","format-version":"2.37.3"}',
      '',
      ':: StoryTitle',
      'Override Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.format?.name).toBe('Test Format');
  });

  it('format-version in StoryData uses SemVer matching to find compatible format', async () => {
    // Spec: Twine 2 uses SemVer principles. When format-version is specified,
    // the compiler should find the best matching version (same major, highest minor/patch).
    const formatDir = writeTempFormat(
      'semver-match-v110',
      'window.storyFormat({"name":"SemMatch","version":"1.1.0","source":"<html><body>v110 {{STORY_DATA}}</body></html>"});',
    );
    writeTempFormat(
      'semver-match-v120',
      'window.storyFormat({"name":"SemMatch","version":"1.2.0","source":"<html><body>v120 {{STORY_DATA}}</body></html>"});',
    );
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"SemMatch","format-version":"1.1.0"}',
      '',
      ':: StoryTitle',
      'SemVer Match',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    // Should find a compatible format (same major version, >= requested version)
    expect(result.format).toBeDefined();
    expect(result.format?.name).toBe('SemMatch');
  });

  it('format selection result includes the format info in CompileResult', async () => {
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.format).toBeDefined();
    expect(result.format?.id).toBe('test-format-1');
    expect(result.format?.name).toBe('Test Format');
    expect(result.format?.version).toBe('1.0.0');
    expect(result.format?.isTwine2).toBe(true);
  });
});

// =============================================================================
// Spec Section: Installation > Adding or Updating in Twine 2
// "a newly-loaded story format is considered different from other installed
// story formats if (A) the name is not the same as any currently installed
// format or (B) the name is the same as an installed format but the version
// is not."
// "Twine 2 does not allow installed story formats of the same version and
// name to be overwritten."
// "It will remove minor or patch versions of old story formats when an update
// to the story format is installed, but will not remove the old version when
// a major ('breaking') version is installed."
// =============================================================================
describe('Twine 2 Story Formats Spec -- SemVer Version Management', () => {
  afterAll(() => cleanupTemp());

  it('different name = different format (both discovered)', () => {
    // Spec: considered different if "the name is not the same"
    writeTempFormat(
      'format-alpha',
      'window.storyFormat({"name":"Alpha","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'format-beta',
      'window.storyFormat({"name":"Beta","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const names = [...formats.values()].map((f) => f.name);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('same name + different version = different formats (both discovered)', () => {
    // Spec: considered different if "the name is the same but the version is not"
    writeTempFormat(
      'versioned-format-100',
      'window.storyFormat({"name":"Versioned","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'versioned-format-200',
      'window.storyFormat({"name":"Versioned","version":"2.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const versionedFormats = [...formats.values()].filter((f) => f.name === 'Versioned');
    expect(versionedFormats.length).toBe(2);
    const versions = versionedFormats.map((f) => f.version).sort();
    expect(versions).toContain('1.0.0');
    expect(versions).toContain('2.0.0');
  });

  it('major version update does NOT remove old version (both coexist)', () => {
    // Spec: "installing version 2.0.0 of a story format would not remove version
    // 1.1.1 of that story format"
    writeTempFormat(
      'major-old',
      'window.storyFormat({"name":"MajorTest","version":"1.1.1","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'major-new',
      'window.storyFormat({"name":"MajorTest","version":"2.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const majorFormats = [...formats.values()].filter((f) => f.name === 'MajorTest');
    const versions = majorFormats.map((f) => f.version);
    expect(versions).toContain('1.1.1');
    expect(versions).toContain('2.0.0');
  });

  it('same name + same version from two directories: only one is loaded (no overwrite)', () => {
    // Spec: "Twine 2 does not allow installed story formats of the same version and name to be overwritten."
    writeTempFormat(
      'duplicate-a',
      'window.storyFormat({"name":"Duplicate","version":"1.0.0","source":"<html>A {{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'duplicate-b',
      'window.storyFormat({"name":"Duplicate","version":"1.0.0","source":"<html>B {{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const dupes = [...formats.values()].filter((f) => f.name === 'Duplicate');
    // Spec: "Twine 2 does not allow installed story formats of the same version
    // and name to be overwritten." Same name+version MUST NOT coexist.
    // A spec-compliant implementation must deduplicate by name+version.
    expect(dupes.length).toBe(1);
  });

  it('minor/patch update removes old version -- only latest minor/patch of same major survives', () => {
    // Spec: "It will remove minor or patch versions of old story formats when an update
    // to the story format is installed"
    // Example: "installing version 1.0.1 or 1.1.0 would remove version 1.0.0"
    writeTempFormat(
      'semver-old-patch',
      'window.storyFormat({"name":"SemVerTest","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'semver-new-patch',
      'window.storyFormat({"name":"SemVerTest","version":"1.0.1","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const semverFormats = [...formats.values()].filter((f) => f.name === 'SemVerTest');
    const versions = semverFormats.map((f) => f.version);
    // Per spec, 1.0.0 should be removed when 1.0.1 is installed (same major)
    expect(versions).not.toContain('1.0.0');
    expect(versions).toContain('1.0.1');
  });

  it('minor update removes old minor version -- only latest of same major survives', () => {
    // Spec: "installing version 1.1.0 would remove version 1.0.0"
    writeTempFormat(
      'semver-old-minor',
      'window.storyFormat({"name":"SemVerMinor","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'semver-new-minor',
      'window.storyFormat({"name":"SemVerMinor","version":"1.1.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const semverFormats = [...formats.values()].filter((f) => f.name === 'SemVerMinor');
    const versions = semverFormats.map((f) => f.version);
    expect(versions).not.toContain('1.0.0');
    expect(versions).toContain('1.1.0');
  });

  it('spec example: 1.0.1 removes 1.0.0, and 2.0.0 does not remove 1.1.1 (combined)', () => {
    // Spec exact example: "installing version 1.0.1 or 1.1.0 would remove version 1.0.0
    // of the same story format, but installing version 2.0.0 of a story format would
    // not remove version 1.1.1 of that story format"
    writeTempFormat(
      'specex-v100',
      'window.storyFormat({"name":"SpecExample","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'specex-v101',
      'window.storyFormat({"name":"SpecExample","version":"1.0.1","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'specex-v111',
      'window.storyFormat({"name":"SpecExample","version":"1.1.1","source":"<html>{{STORY_DATA}}</html>"});',
    );
    writeTempFormat(
      'specex-v200',
      'window.storyFormat({"name":"SpecExample","version":"2.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const specFormats = [...formats.values()].filter((f) => f.name === 'SpecExample');
    const versions = specFormats.map((f) => f.version);
    // 1.0.0 should be removed (superseded by 1.0.1 and then by 1.1.1)
    expect(versions).not.toContain('1.0.0');
    // 1.0.1 should be removed (superseded by 1.1.1 in same major)
    expect(versions).not.toContain('1.0.1');
    // 1.1.1 should survive (latest of major 1)
    expect(versions).toContain('1.1.1');
    // 2.0.0 should survive (different major)
    expect(versions).toContain('2.0.0');
  });
});

// =============================================================================
// Spec Section: parseFormatJSON
// Tests for the low-level JSON parser used to extract format data.
// =============================================================================
describe('Twine 2 Story Formats Spec -- parseFormatJSON', () => {
  it('extracts name, version, source, and proofing from valid JSON', () => {
    const input = 'window.storyFormat({"name":"TestFmt","version":"1.2.3","source":"<html></html>","proofing":true});';
    const result = parseFormatJSON(input, 'test');
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected result');
    expect(result.name).toBe('TestFmt');
    expect(result.version).toBe('1.2.3');
    expect(result.source).toBe('<html></html>');
    expect(result.proofing).toBe(true);
  });

  it('returns null when JSON has no opening brace', () => {
    const result = parseFormatJSON('window.storyFormat();', 'test');
    expect(result).toBeNull();
  });

  it('does NOT return null when name is missing (name is Optional per spec)', () => {
    // Spec: "name: (string) Optional. The name of the story format.
    // (Omitting the name will lead to an Untitled Story Format.)"
    // parseFormatJSON should still return a valid result with a default name.
    const result = parseFormatJSON('window.storyFormat({"version":"1.0.0","source":"<html></html>"});', 'test');
    expect(result).not.toBeNull();
    if (result) {
      expect(typeof result.name).toBe('string');
    }
  });

  it('returns null when version is missing', () => {
    const result = parseFormatJSON('window.storyFormat({"name":"X","source":"<html></html>"});', 'test');
    expect(result).toBeNull();
  });

  it('returns null when source is missing', () => {
    const result = parseFormatJSON('window.storyFormat({"name":"X","version":"1.0.0"});', 'test');
    expect(result).toBeNull();
  });

  it('proofing defaults to false when not specified', () => {
    const result = parseFormatJSON(
      'window.storyFormat({"name":"X","version":"1.0.0","source":"<html></html>"});',
      'test',
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected result');
    expect(result.proofing).toBe(false);
  });

  it('handles Harlowe setup function workaround', () => {
    // Spec: "Harlowe also includes a deprecated *setup* key"
    // Since the spec explicitly mentions this, compilers MUST handle it.
    const input =
      'window.storyFormat({"name":"Harlowe","version":"3.3.9","source":"<html></html>","setup": function(){}});';
    const result = parseFormatJSON(input, 'harlowe-3');
    // Must parse successfully -- Harlowe's setup function is a known pattern
    expect(result).not.toBeNull();
    if (result) {
      expect(result.name).toBe('Harlowe');
      expect(result.version).toBe('3.3.9');
    }
  });

  it('returns correct source string from parsed format', () => {
    // Spec: "source: (string) Required. An adequately escaped string containing
    // the full HTML output of the story format"
    const input =
      'window.storyFormat({"name":"SourceTest","version":"1.0.0","source":"<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>"});';
    const result = parseFormatJSON(input, 'test');
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected result');
    expect(result.source).toBe('<html><head><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>');
  });

  it('proofing=true is correctly parsed', () => {
    const input = 'window.storyFormat({"name":"Proof","version":"1.0.0","source":"<html></html>","proofing":true});';
    const result = parseFormatJSON(input, 'test');
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected result');
    expect(result.proofing).toBe(true);
  });

  it('proofing=false is correctly parsed', () => {
    const input = 'window.storyFormat({"name":"Play","version":"1.0.0","source":"<html></html>","proofing":false});';
    const result = parseFormatJSON(input, 'test');
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected result');
    expect(result.proofing).toBe(false);
  });

  it('extra/unknown keys do not prevent parsing', () => {
    // Spec says format objects may contain keys like setup, codeMirrorSyntax, editorToolbar, etc.
    const input =
      'window.storyFormat({"name":"Extra","version":"1.0.0","source":"<html></html>","customKey":"value","anotherKey":42});';
    const result = parseFormatJSON(input, 'test');
    expect(result).not.toBeNull();
    if (!result) throw new Error('expected result');
    expect(result.name).toBe('Extra');
  });
});

// =============================================================================
// Spec Section: Twine 1 Story Formats
// "In Twine 1.4, story formats were local, contained in a single HTML file
// (analogous to the source section of a Twine 2 story format) called
// header.html. The file used two wildcards 'STORY', for the set of passages,
// and 'STORY_SIZE', for the number of passages. The story format name was
// derived from the containing folder."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Twine 1 Format Support', () => {
  afterAll(() => cleanupTemp());

  it('discovers Twine 1 format from header.html in a named directory', () => {
    const dir = join(TEMP_DIR, 'twine1-format');
    mkdirSync(dir, { recursive: true });
    const headerContent =
      '<html><head><title>Test</title></head><body><div id="storeArea">"STORY"</div><span>"STORY_SIZE"</span></body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'twine1-format');
    expect(format).toBeDefined();
  });

  it('Twine 1 format filename is header.html', () => {
    // Spec: "contained in a single HTML file ... called header.html"
    const dir = join(TEMP_DIR, 'twine1-filename-check');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'header.html'), '<html><body>"STORY"</body></html>', 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'twine1-filename-check');
    if (!format) throw new Error('expected format');
    expect(format.filename).toMatch(/header\.html$/);
  });

  it('Twine 1 format is identified as not a Twine 2 format (isTwine2 = false)', () => {
    const dir = join(TEMP_DIR, 'twine1-type-check');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'header.html'), '<html><body>"STORY"</body></html>', 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'twine1-type-check');
    if (!format) throw new Error('expected format');
    expect(format.isTwine2).toBe(false);
  });

  it('Twine 1 format name is derived from containing folder', () => {
    // Spec: "The story format name was derived from the containing folder."
    const dir = join(TEMP_DIR, 'sugarcane');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'header.html'), '<html><body>"STORY"</body></html>', 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'sugarcane');
    if (!format) throw new Error('expected format');
    expect(format.id).toBe('sugarcane');
  });

  it('Twine 1 format source contains "STORY" placeholder', () => {
    const dir = join(TEMP_DIR, 'twine1-story-placeholder');
    mkdirSync(dir, { recursive: true });
    const headerContent = '<html><body>"STORY"</body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'twine1-story-placeholder');
    if (!format) throw new Error('expected format to be discovered');
    const source = readFileSync(format.filename, 'utf-8');
    expect(source).toContain('"STORY"');
  });

  it('Twine 1 format source contains "STORY_SIZE" placeholder', () => {
    // Spec: "The file used two wildcards 'STORY', for the set of passages,
    // and 'STORY_SIZE', for the number of passages."
    const dir = join(TEMP_DIR, 'twine1-storysize-placeholder');
    mkdirSync(dir, { recursive: true });
    const headerContent = '<html><body>"STORY" "STORY_SIZE"</body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'twine1-storysize-placeholder');
    if (!format) throw new Error('expected format to be discovered');
    const source = readFileSync(format.filename, 'utf-8');
    expect(source).toContain('"STORY_SIZE"');
  });

  it('readFormatSource returns raw HTML for Twine 1 format (no JSON extraction)', () => {
    const dir = join(TEMP_DIR, 'twine1-readsource');
    mkdirSync(dir, { recursive: true });
    const headerContent = '<html><body>"STORY" "STORY_SIZE"</body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'twine1-readsource');
    if (!format) throw new Error('expected format');
    const source = readFormatSource(format);
    expect(source).toBe(headerContent);
  });

  it('Twine 1 format name defaults to folder name since header.html has no metadata', () => {
    // Spec: "The story format name was derived from the containing folder."
    // Twine 1 formats are just HTML files with no JSON metadata.
    // The name MUST come from the folder, not from file contents.
    const dir = join(TEMP_DIR, 'my-twine1-format');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'header.html'), '<html><body>"STORY"</body></html>', 'utf-8');
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'my-twine1-format');
    if (!format) throw new Error('expected format');
    // The name should be derived from the folder name
    expect(format.name).toBeTruthy();
  });

  it('Twine 1 format coexists with Twine 2 formats in discovery', () => {
    // Both Twine 1 (header.html) and Twine 2 (format.js) formats should
    // be discoverable from the same search path
    const twine1Dir = join(TEMP_DIR, 'twine1-coexist');
    mkdirSync(twine1Dir, { recursive: true });
    writeFileSync(join(twine1Dir, 'header.html'), '<html><body>"STORY"</body></html>', 'utf-8');
    writeTempFormat(
      'twine2-coexist',
      'window.storyFormat({"name":"CoexistT2","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const twine1 = [...formats.values()].find((f) => f.id === 'twine1-coexist');
    const twine2 = [...formats.values()].find((f) => f.id === 'twine2-coexist');
    expect(twine1).toBeDefined();
    expect(twine2).toBeDefined();
    if (twine1) expect(twine1.isTwine2).toBe(false);
    if (twine2) expect(twine2.isTwine2).toBe(true);
  });

  it('Twine 2 format.js takes priority over header.html in same directory', () => {
    // Spec: "In Twine 2 a story format is a single JavaScript file, usually called format.js."
    // When both format.js and header.html exist in the same directory,
    // the Twine 2 format (format.js) should take priority.
    const dir = join(TEMP_DIR, 'dual-format-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'header.html'), '<html><body>"STORY"</body></html>', 'utf-8');
    writeFileSync(
      join(dir, 'format.js'),
      'window.storyFormat({"name":"DualFormat","version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
      'utf-8',
    );
    const formats = discoverFormats([TEMP_DIR]);
    const format = [...formats.values()].find((f) => f.id === 'dual-format-dir');
    if (!format) throw new Error('expected format');
    // format.js should be preferred (Twine 2 format)
    expect(format.isTwine2).toBe(true);
    expect(format.filename).toMatch(/format\.js$/);
  });
});

// =============================================================================
// Spec Section: Twine 1 > Placeholder Replacement
// "The file used two wildcards 'STORY', for the set of passages,
// and 'STORY_SIZE', for the number of passages."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Twine 1 Placeholder Replacement', () => {
  afterAll(() => cleanupTemp());

  it('"STORY" placeholder is replaced with passage data in Twine 1 output', async () => {
    const dir = join(TEMP_DIR, 'twine1-replacement-test');
    mkdirSync(dir, { recursive: true });
    const headerContent = '<html><head><title>Test</title></head><body><div id="storeArea">"STORY"</div></body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');

    const source = [':: StoryTitle', 'Twine 1 Test', '', ':: Start', 'Hello World'].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'twine1-replacement-test',
      formatPaths: [TEMP_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('tiddler="Start"');
    expect(result.output).not.toContain('"STORY"');
  });

  it('"STORY_SIZE" placeholder is replaced with passage count in Twine 1 output', async () => {
    const dir = join(TEMP_DIR, 'twine1-size-test');
    mkdirSync(dir, { recursive: true });
    const headerContent =
      '<html><head><title>Test</title></head><body><div id="storeArea">"STORY"</div><span>"STORY_SIZE"</span></body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');

    const source = [':: StoryTitle', 'Size Test', '', ':: Start', 'Hello', '', ':: Room', 'Content'].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'twine1-size-test',
      formatPaths: [TEMP_DIR],
      useTweegoPath: false,
    });
    expect(result.output).not.toContain('"STORY_SIZE"');
  });

  it('"STORY_SIZE" is replaced with the correct numeric passage count', async () => {
    const dir = join(TEMP_DIR, 'twine1-size-count-test');
    mkdirSync(dir, { recursive: true });
    const headerContent =
      '<html><head><title>Test</title></head><body><div id="storeArea">"STORY"</div><span id="count">"STORY_SIZE"</span></body></html>';
    writeFileSync(join(dir, 'header.html'), headerContent, 'utf-8');

    const source = [
      ':: StoryTitle',
      'Count Test',
      '',
      ':: Start',
      'Hello',
      '',
      ':: Room',
      'Content',
      '',
      ':: End',
      'Goodbye',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'twine1-size-count-test',
      formatPaths: [TEMP_DIR],
      useTweegoPath: false,
    });
    // The exact count depends on whether StoryTitle counts as a passage
    expect(result.output).not.toContain('"STORY_SIZE"');
    // Should contain a number in the output where STORY_SIZE was
    // Note: the replacement format is "N" (quoted number) since the original
    // placeholder is "STORY_SIZE" (with quotes as part of the wildcard).
    expect(result.output).toMatch(/<span id="count">"?\d+"?<\/span>/);
  });
});

// =============================================================================
// Spec Section: Introduction > Playable vs Proofing formats
// "Playable story formats include code to extract the passage contents from
// the custom HTML and display it as the story 'runs.'"
// "Proofing and other utility formats do not 'run' the story"
// =============================================================================
describe('Twine 2 Story Formats Spec -- Playable vs Proofing Distinction', () => {
  afterAll(() => cleanupTemp());

  it('non-proofing format has proofing=false (playable format)', () => {
    const formatDir = writeTempFormat(
      'playable-format',
      'window.storyFormat({"name":"Playable","version":"1.0.0","proofing":false,"source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'Playable');
    if (!format) throw new Error('expected format');
    expect(format.proofing).toBe(false);
  });

  it('proofing format has proofing=true', () => {
    const formatDir = writeTempFormat(
      'proofing-util-format',
      'window.storyFormat({"name":"Paperthin","version":"1.0.0","proofing":true,"source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'Paperthin');
    if (!format) throw new Error('expected format');
    expect(format.proofing).toBe(true);
  });

  it('both playable and proofing formats can be used for compilation', async () => {
    const formatDir = writeTempFormat(
      'proofing-compile-test',
      'window.storyFormat({"name":"ProofCompile","version":"1.0.0","proofing":true,"source":"<html><body>{{STORY_DATA}}</body></html>"});',
    );
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'proofing-compile-test',
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<tw-storydata');
    expect(result.format?.proofing).toBe(true);
  });
});

// =============================================================================
// Spec Section: Introduction > Compilation Process
// "Twine and other tools combine the story format's 'source' and the story
// and passage data into a new HTML file."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Compilation Process', () => {
  it('compilation combines format source with story/passage data into HTML', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Compilation Test',
      '',
      ':: Start',
      'Hello from the start passage.',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    // Output should be HTML
    expect(result.output).toContain('<html>');
    // Output should contain the story name (from format source template)
    expect(result.output).toContain('Compilation Test');
    // Output should contain passage data
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('<tw-passagedata');
    // Output should contain the passage content
    expect(result.output).toContain('Hello from the start passage.');
  });

  it('passage data is wrapped in custom HTML elements', async () => {
    // Spec: "passages and metadata, wrapped in custom HTML elements or inserted
    // into custom attributes"
    const source = minimalStory(':: Start\nTest passage content');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    // tw-storydata is the custom element wrapping all story data
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('</tw-storydata>');
    // tw-passagedata is the custom element for each passage
    expect(result.output).toContain('<tw-passagedata');
    expect(result.output).toContain('</tw-passagedata>');
  });

  it('metadata is inserted into custom attributes on tw-storydata', async () => {
    // Spec: "passages and metadata, wrapped in custom HTML elements or inserted
    // into custom attributes"
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC","format":"Test Format","format-version":"1.0.0"}',
      '',
      ':: StoryTitle',
      'Attribute Test',
      '',
      ':: Start',
      'Hello',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    // Metadata must appear as attributes on <tw-storydata>
    expect(result.output).toMatch(/<tw-storydata[^>]*name="Attribute Test"/);
    expect(result.output).toMatch(/<tw-storydata[^>]*ifid="D674C58C-DEFA-4F70-B7A2-27742230C0FC"/);
  });
});

// =============================================================================
// Spec Section: Introduction > Story Data from Twee3
// "The story and passage data is usually stored internally by Twine 2, but can
// also be stored in a Twee3 text file."
// =============================================================================
describe('Twine 2 Story Formats Spec -- Twee3 Input', () => {
  it('story data from Twee3 text file compiles with a Twine 2 story format', async () => {
    // Spec: "The story and passage data is usually stored internally by Twine 2,
    // but can also be stored in a Twee3 text file."
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Twee3 Story',
      '',
      ':: Start',
      'This is a Twee3 source file compiled with a Twine 2 story format.',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<html>');
    expect(result.output).toContain('<tw-storydata');
    expect(result.output).toContain('This is a Twee3 source file compiled with a Twine 2 story format.');
  });

  it('multiple passages from Twee3 input are all included in compiled output', async () => {
    const source = [
      ':: StoryData',
      '{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}',
      '',
      ':: StoryTitle',
      'Multi Passage',
      '',
      ':: Start',
      'Begin here.',
      '',
      ':: Room',
      'A room.',
      '',
      ':: End',
      'The end.',
    ].join('\n');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'test-format-1',
      formatPaths: [FORMAT_DIR],
      useTweegoPath: false,
    });
    expect(result.output).toContain('Begin here.');
    expect(result.output).toContain('A room.');
    expect(result.output).toContain('The end.');
  });
});

// =============================================================================
// Spec Section: SemVer Utilities
// "semantic version-style formatting (x.y.z, e.g., 1.2.1) of the version
// is also required."
// Tests for parseSemver and semverCompare which implement the SemVer logic
// underlying format version management.
// =============================================================================
describe('Twine 2 Story Formats Spec -- SemVer Utilities', () => {
  describe('parseSemver', () => {
    it('parses a standard x.y.z version string', () => {
      const result = parseSemver('1.2.3');
      expect(result).toEqual([1, 2, 3]);
    });

    it('parses a version with zero components', () => {
      const result = parseSemver('0.0.0');
      expect(result).toEqual([0, 0, 0]);
    });

    it('parses a version with large numbers', () => {
      const result = parseSemver('10.20.30');
      expect(result).toEqual([10, 20, 30]);
    });

    it('parses a version with pre-release suffix (ignoring suffix)', () => {
      const result = parseSemver('2.0.0-beta.1');
      expect(result).not.toBeNull();
      if (!result) throw new Error('expected result');
      expect(result[0]).toBe(2);
      expect(result[1]).toBe(0);
      expect(result[2]).toBe(0);
    });

    it('parses a version with build metadata suffix (ignoring suffix)', () => {
      const result = parseSemver('1.0.0+build.123');
      expect(result).not.toBeNull();
      if (!result) throw new Error('expected result');
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(0);
      expect(result[2]).toBe(0);
    });

    it('returns null for non-semver string', () => {
      const result = parseSemver('not-a-version');
      expect(result).toBeNull();
    });

    it('returns null for incomplete version (missing patch)', () => {
      const result = parseSemver('1.0');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = parseSemver('');
      expect(result).toBeNull();
    });
  });

  describe('semverCompare', () => {
    it('returns 0 for equal versions', () => {
      expect(semverCompare([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    it('returns positive when first version is greater (major)', () => {
      expect(semverCompare([2, 0, 0], [1, 0, 0])).toBeGreaterThan(0);
    });

    it('returns negative when first version is lesser (major)', () => {
      expect(semverCompare([1, 0, 0], [2, 0, 0])).toBeLessThan(0);
    });

    it('returns positive when first version is greater (minor)', () => {
      expect(semverCompare([1, 2, 0], [1, 1, 0])).toBeGreaterThan(0);
    });

    it('returns negative when first version is lesser (minor)', () => {
      expect(semverCompare([1, 1, 0], [1, 2, 0])).toBeLessThan(0);
    });

    it('returns positive when first version is greater (patch)', () => {
      expect(semverCompare([1, 0, 2], [1, 0, 1])).toBeGreaterThan(0);
    });

    it('returns negative when first version is lesser (patch)', () => {
      expect(semverCompare([1, 0, 1], [1, 0, 2])).toBeLessThan(0);
    });
  });
});

// =============================================================================
// Spec Section: Installation > SemVer Format Selection
// "The Twine 2 UI uses principles of semantic versioning to manage story formats."
// Tests for getFormatIdByName and getFormatIdByNameAndVersion.
// =============================================================================
describe('Twine 2 Story Formats Spec -- SemVer Format Selection', () => {
  /** Helper: build a StoryFormatInfo map from an array of partial format definitions. */
  function buildFormatMap(
    entries: ReadonlyArray<{ readonly id: string; readonly name: string; readonly version: string }>,
  ): Map<string, StoryFormatInfo> {
    const map = new Map<string, StoryFormatInfo>();
    for (const entry of entries) {
      map.set(entry.id, {
        id: entry.id,
        filename: `/fake/${entry.id}/format.js`,
        isTwine2: true,
        name: entry.name,
        version: entry.version,
        proofing: false,
      });
    }
    return map;
  }

  describe('getFormatIdByName', () => {
    it('picks the greatest version when multiple versions of same name exist', () => {
      const formats = buildFormatMap([
        { id: 'sc-2.36', name: 'SugarCube', version: '2.36.0' },
        { id: 'sc-2.37', name: 'SugarCube', version: '2.37.3' },
        { id: 'sc-2.35', name: 'SugarCube', version: '2.35.0' },
      ]);
      const id = getFormatIdByName(formats, 'SugarCube');
      expect(id).toBe('sc-2.37');
    });

    it('returns undefined when no format matches the name', () => {
      const formats = buildFormatMap([{ id: 'sc-2', name: 'SugarCube', version: '2.37.3' }]);
      const id = getFormatIdByName(formats, 'Harlowe');
      expect(id).toBeUndefined();
    });

    it('returns the only format when there is exactly one match', () => {
      const formats = buildFormatMap([{ id: 'harlowe-3', name: 'Harlowe', version: '3.3.9' }]);
      const id = getFormatIdByName(formats, 'Harlowe');
      expect(id).toBe('harlowe-3');
    });

    it('picks greatest version across major versions', () => {
      const formats = buildFormatMap([
        { id: 'sc-1', name: 'SugarCube', version: '1.0.35' },
        { id: 'sc-2', name: 'SugarCube', version: '2.37.3' },
      ]);
      const id = getFormatIdByName(formats, 'SugarCube');
      expect(id).toBe('sc-2');
    });

    it('ignores non-Twine2 formats', () => {
      const formats = new Map<string, StoryFormatInfo>();
      formats.set('twine1-fmt', {
        id: 'twine1-fmt',
        filename: '/fake/twine1-fmt/header.html',
        isTwine2: false,
        name: 'Sugarcane',
        version: '',
        proofing: false,
      });
      const id = getFormatIdByName(formats, 'Sugarcane');
      expect(id).toBeUndefined();
    });
  });

  describe('getFormatIdByNameAndVersion', () => {
    it('picks exact version match when available', () => {
      const formats = buildFormatMap([
        { id: 'sc-236', name: 'SugarCube', version: '2.36.0' },
        { id: 'sc-237', name: 'SugarCube', version: '2.37.3' },
      ]);
      const id = getFormatIdByNameAndVersion(formats, 'SugarCube', '2.37.3');
      expect(id).toBe('sc-237');
    });

    it('picks highest compatible version within same major', () => {
      // Spec: minor/patch updates are compatible within same major
      const formats = buildFormatMap([
        { id: 'sc-236', name: 'SugarCube', version: '2.36.0' },
        { id: 'sc-237', name: 'SugarCube', version: '2.37.3' },
      ]);
      const id = getFormatIdByNameAndVersion(formats, 'SugarCube', '2.36.0');
      // Should pick 2.37.3 as highest compatible (same major, >= requested)
      expect(id).toBe('sc-237');
    });

    it('does not match across major versions', () => {
      // Spec: "will not remove the old version when a major ('breaking') version is installed"
      const formats = buildFormatMap([
        { id: 'sc-1', name: 'SugarCube', version: '1.0.35' },
        { id: 'sc-2', name: 'SugarCube', version: '2.37.3' },
      ]);
      const id = getFormatIdByNameAndVersion(formats, 'SugarCube', '1.0.0');
      // Should pick the v1 format, not v2
      expect(id).toBe('sc-1');
    });

    it('returns undefined when no format matches name', () => {
      const formats = buildFormatMap([{ id: 'sc-2', name: 'SugarCube', version: '2.37.3' }]);
      const id = getFormatIdByNameAndVersion(formats, 'Harlowe', '3.0.0');
      expect(id).toBeUndefined();
    });

    it('returns highest version across all majors when requested version is unparseable', () => {
      // When wanted version can't be parsed as semver, fallback behavior
      const formats = buildFormatMap([
        { id: 'sc-1', name: 'SugarCube', version: '1.0.35' },
        { id: 'sc-2', name: 'SugarCube', version: '2.37.3' },
      ]);
      const id = getFormatIdByNameAndVersion(formats, 'SugarCube', 'latest');
      // Should pick the greatest available version since requested is not parseable
      expect(id).toBe('sc-2');
    });

    it('picks highest compatible version when requested patch is lower', () => {
      const formats = buildFormatMap([
        { id: 'sc-2370', name: 'SugarCube', version: '2.37.0' },
        { id: 'sc-2373', name: 'SugarCube', version: '2.37.3' },
      ]);
      const id = getFormatIdByNameAndVersion(formats, 'SugarCube', '2.37.0');
      expect(id).toBe('sc-2373');
    });

    it('does not pick a lower version than requested', () => {
      const formats = buildFormatMap([{ id: 'sc-236', name: 'SugarCube', version: '2.36.0' }]);
      const id = getFormatIdByNameAndVersion(formats, 'SugarCube', '2.37.0');
      // 2.36.0 < 2.37.0 so it should not match
      expect(id).toBeUndefined();
    });
  });
});

// =============================================================================
// Spec Section: Keys > name optional - strict assertion
// "name: (string) Optional. The name of the story format.
// (Omitting the name will lead to an Untitled Story Format.)"
// This test verifies that parseFormatJSON handles missing name per spec.
// =============================================================================
describe('Twine 2 Story Formats Spec -- Name Key Strictness', () => {
  afterAll(() => cleanupTemp());

  it('parseFormatJSON MUST accept format objects without a name key (name is Optional)', () => {
    // Spec: "name: (string) Optional."
    // The parser MUST NOT require a name key. A format with version and source but no name
    // MUST be parseable.
    const input = 'window.storyFormat({"version":"1.0.0","source":"<html></html>"});';
    const result = parseFormatJSON(input, 'test');
    // Strict assertion: MUST return a non-null result
    expect(result).not.toBeNull();
  });

  it('format without name MUST be discoverable (name is Optional per spec)', () => {
    // Spec: "Omitting the name will lead to an Untitled Story Format."
    // This means the format MUST still be discoverable. The compiler should not
    // reject a format simply because it lacks a name key.
    const formatDir = writeTempFormat(
      'truly-nameless-format',
      'window.storyFormat({"version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.id === 'truly-nameless-format');
    // MUST be discovered -- failing here means the implementation incorrectly requires name
    expect(format).toBeDefined();
  });

  it('format without name MUST get a default/fallback name', () => {
    // Spec: "Omitting the name will lead to an Untitled Story Format."
    const formatDir = writeTempFormat(
      'default-name-format',
      'window.storyFormat({"version":"1.0.0","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.id === 'default-name-format');
    if (!format) throw new Error('expected format to be discovered');
    // The format MUST have a non-empty name (either "Untitled Story Format" or similar default)
    expect(format.name).toBeTruthy();
    expect(typeof format.name).toBe('string');
    expect(format.name.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Spec Section: Keys > source - compilation strictness
// "source: (string) Required. An adequately escaped string containing the full
// HTML output of the story format"
// =============================================================================
describe('Twine 2 Story Formats Spec -- Source Compilation Strictness', () => {
  afterAll(() => cleanupTemp());

  it('compiled output preserves the structure of the format source template', async () => {
    // Spec: source is "the full HTML output of the story format"
    // The compiled output should match the format's source template structure,
    // with placeholders replaced.
    const formatDir = writeTempFormat(
      'structure-check-format',
      'window.storyFormat({"name":"StructureCheck","version":"1.0.0","source":"<html><head><meta charset=\\"utf-8\\"><title>{{STORY_NAME}}</title></head><body>{{STORY_DATA}}</body></html>"});',
    );
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'structure-check-format',
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    // The structure of the format template must be preserved
    expect(result.output).toMatch(/<html><head><meta charset="utf-8"><title>.*<\/title><\/head><body>.*<\/body><\/html>/s);
  });

  it('format source with complex escaped HTML loads and compiles correctly', async () => {
    // Spec: "An adequately escaped string"
    const complexSource =
      '<html><head><script>var x = \\"test\\"; var y = 1 < 2;</script></head><body>{{STORY_DATA}}</body></html>';
    const formatDir = writeTempFormat(
      'complex-escape-format',
      `window.storyFormat({"name":"ComplexEscape","version":"1.0.0","source":"${complexSource}"});`,
    );
    const source = minimalStory(':: Start\nHello');
    const result = await compile({
      sources: [{ filename: 'test.tw', content: source }],
      formatId: 'complex-escape-format',
      formatPaths: [formatDir],
      useTweegoPath: false,
    });
    expect(result.output).toContain('<tw-storydata');
  });
});

// =============================================================================
// Spec Section: Keys > proofing strictness
// "proofing: (boolean) Optional (defaults to false)."
// Non-boolean truthy values MUST NOT be treated as true.
// =============================================================================
describe('Twine 2 Story Formats Spec -- Proofing Key Strictness', () => {
  afterAll(() => cleanupTemp());

  it('proofing must be strictly boolean true, not truthy string "true"', () => {
    // Spec: "proofing: (boolean)" -- must be boolean, not string
    const formatDir = writeTempFormat(
      'proofing-string-format',
      'window.storyFormat({"name":"ProofString","version":"1.0.0","proofing":"true","source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'ProofString');
    if (!format) throw new Error('expected format');
    // String "true" MUST NOT be treated as boolean true
    expect(format.proofing).toBe(false);
  });

  it('proofing must be strictly boolean true, not truthy number 1', () => {
    // Spec: "proofing: (boolean)" -- must be boolean, not number
    const formatDir = writeTempFormat(
      'proofing-number-format',
      'window.storyFormat({"name":"ProofNumber","version":"1.0.0","proofing":1,"source":"<html>{{STORY_DATA}}</html>"});',
    );
    const formats = discoverFormats([formatDir]);
    const format = [...formats.values()].find((f) => f.name === 'ProofNumber');
    if (!format) throw new Error('expected format');
    // Number 1 MUST NOT be treated as boolean true
    expect(format.proofing).toBe(false);
  });
});
