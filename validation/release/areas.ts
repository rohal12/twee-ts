/**
 * The review areas: the whole supported surface, split so a full review sweep can say what it
 * covered. Every file under src/, bin/ and schemas/, and every page of the documentation, belongs to
 * an area (test/review-areas.test.ts checks it), so a new file is assigned before a release can be
 * reviewed. A full sweep covers every area (validation/release/gate.ts).
 *
 * A path ending in `/` stands for everything under it.
 */
export interface ReviewArea {
  readonly id: string;
  /** What the area promises: what a reviewer checks there. */
  readonly contract: string;
  readonly paths: readonly string[];
}

export const REVIEW_AREAS: readonly ReviewArea[] = [
  {
    id: 'api',
    contract: 'The public API and types, compile orchestration, incremental equivalence, cancellation, diagnostics',
    paths: [
      'src/index.ts',
      'src/types.ts',
      'src/compiler.ts',
      'src/errors.ts',
      'src/diagnostic-text.ts',
      'src/build-time.ts',
      'src/version.ts',
    ],
  },
  {
    id: 'syntax',
    contract: 'Twee notation: lexing, parsing, Twee2 headers, source normalization, link and macro reading',
    paths: [
      'src/lexer.ts',
      'src/parser.ts',
      'src/twee-syntax.ts',
      'src/twee2-compat.ts',
      'src/source-text.ts',
      'src/link-markup.ts',
      'src/sugarcube-macros.ts',
    ],
  },
  {
    id: 'story',
    contract: 'The story model: special passages, metadata precedence, omission, start passage, IFID, inspection, lint',
    paths: [
      'src/story.ts',
      'src/passage.ts',
      'src/passage-omission.ts',
      'src/start-passage.ts',
      'src/ifid.ts',
      'src/word-count.ts',
      'src/inspect.ts',
      'src/lint.ts',
    ],
  },
  {
    id: 'inputs',
    contract: 'Reading sources, modules and the head file: file types, encodings, exclusions, the input policy',
    paths: ['src/loader.ts', 'src/media-types.ts', 'src/input-policy.ts', 'src/util.ts'],
  },
  {
    id: 'files',
    contract: 'Path identity, output safety, atomic writes, links, watch mode',
    paths: ['src/filesystem.ts', 'src/atomic-write.ts', 'src/path-identity.ts'],
  },
  {
    id: 'formats',
    contract: 'Story formats: local discovery, decoding, URLs and indices, selection, the download cache',
    paths: [
      'src/formats.ts',
      'src/format-decode.ts',
      'src/format-resolution.ts',
      'src/format-cache.ts',
      'src/remote-formats.ts',
      'src/semver.ts',
      'src/json-decode.ts',
      'src/js-syntax.ts',
      'src/js-chars.ts',
      'src/javascript-strings.ts',
      'src/code-context.ts',
    ],
  },
  {
    id: 'output',
    contract: 'Twine 2, Twine 1, archive, Twee and JSON output; HTML structure, escaping and injection; decompiling',
    paths: [
      'src/output-twine2.ts',
      'src/output-twine1.ts',
      'src/output-twee.ts',
      'src/twine1-obfuscation.ts',
      'src/template.ts',
      'src/modules.ts',
      'src/escape.ts',
      'src/html-structure.ts',
      'src/css-imports.ts',
      'src/html-output-check.ts',
      'src/html-parser.ts',
    ],
  },
  {
    id: 'cli',
    contract: 'The command line and the config file, and its JSON schema',
    paths: ['bin/twee-ts.ts', 'src/cli-request.ts', 'src/config.ts', 'schemas/twee-ts.config.schema.json'],
  },
  {
    id: 'plugins',
    contract: 'The Vite and Rollup plugins: options, builds, the development server, entry bundling, watching',
    paths: ['src/plugins/'],
  },
  {
    id: 'distribution',
    contract:
      'The published package: exports, types, the bundled dependencies and their notices, supported Node and peers',
    paths: ['package.json', 'tsdown.config.ts', 'THIRD_PARTY_NOTICES'],
  },
  {
    id: 'documentation',
    contract: 'What the README and the documentation promise matches what the package does',
    paths: ['README.md', 'docs/'],
  },
];
