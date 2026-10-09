/**
 * The compiler contract matrix: every case's stable ID, the invariant it checks and the variant of
 * the input. A case ID is `<group>-<NN>`, numbered by the variant's position in its group, so a
 * case keeps its ID and meaning for good: groups and variants are only ever added at the end.
 *
 * Revision 1 (the 59 cases WRITE-01 … ABORT-02) was declared by the draft validation work against
 * v1.18.1 and passed in full on v1.18.2; `matrix.contract.ts` freezes it. Later revisions append.
 */

export const ISSUES = 'https://github.com/rohal12/twee-ts/issues/';

/** One group of cases: the invariant they share and the input variants, in ID order. */
interface CaseGroup {
  readonly invariant: string;
  /** The issue that owns the group's invariant, if one does. */
  readonly issue: number | undefined;
  readonly variants: readonly string[];
}

export const MATRIX = {
  WRITE: {
    invariant: 'Atomic output preserves the destination and the intent of a symbolic link',
    issue: 219,
    variants: [
      'new file',
      'existing file',
      'valid relative symlink',
      'absolute dangling symlink',
      'relative dangling symlink',
      'dangling symlink chain',
      'symlink cycle',
    ],
  },
  TYPE: {
    invariant: 'ReadonlyPassage rejects writes at its public boundaries',
    issue: 220,
    variants: [
      'tag append',
      'tag index assignment',
      'metadata property assignment',
      'source property assignment',
      'name assignment',
    ],
  },
  FORMAT: {
    invariant: 'Lexically equivalent storyFormat wrappers decode identically',
    issue: 221,
    variants: [
      'strict object',
      'relaxed object',
      'comment inside object',
      'leading brace comment',
      'trailing brace comment',
      'surrounding brace comments',
      'braces inside a value',
    ],
  },
  RESOLVE: {
    invariant: 'Format selection and warnings agree across the supported source kinds',
    issue: 224,
    variants: [
      'local exact',
      'local newer',
      'local older',
      'URL exact',
      'URL newer',
      'URL older',
      'index cache exact',
      'index cache newer',
      'index cache older',
    ],
  },
  HEAD: {
    invariant: 'HTML injections preserve literals and create executable elements',
    issue: 223,
    variants: [
      'module: ordinary head',
      'module: comment look-alike',
      'module: script look-alike',
      'module: attribute look-alike',
      'module: quoted head attribute',
      'client: ordinary head',
      'client: comment look-alike',
      'client: script look-alike',
      'client: attribute look-alike',
      'client: quoted head attribute',
    ],
  },
  VITE: {
    invariant: 'Development and production entry builds preserve user configuration',
    issue: 222,
    variants: [
      'ordinary inline config',
      'inline define',
      'inline alias',
      'inline virtual-module plugin',
      'file config with inline define override',
    ],
  },
  INPUT: {
    invariant: 'Source loading and caching preserve the effective authored data',
    issue: undefined,
    variants: [
      'file and inline normalization',
      'mixed source precedence',
      'cold and warm cache parity',
      'forced change with unchanged mtime',
      'parse-option invalidation',
      'generated-name collision',
    ],
  },
  OUTPUT: {
    invariant: 'Output modes preserve their documented metadata and omissions',
    issue: undefined,
    variants: [
      'HTML metadata and text round trip',
      'JSON start and debug overrides',
      'private passage omitted',
      'private start rejected',
      'effective Twee metadata round trip',
      'missing IFID reported',
    ],
  },
  CLI: {
    invariant: 'CLI errors preserve the output, and generated output never becomes input',
    issue: undefined,
    variants: ['compile error preserves previous output', 'output inside sources excluded on repeat build'],
  },
  ABORT: {
    invariant: 'Cancelled compiles reject with the caller reason and preserve the output',
    issue: undefined,
    variants: ['pre-aborted compile', 'abort during direct format request'],
  },
  // Revision 2: the generated interaction corpus of the draft's extended contracts, one case per
  // output mode.
  INTERACT: {
    invariant:
      'Cold, incremental and warm builds agree across sources, line endings, trimming, aliases and replaced metadata',
    issue: undefined,
    variants: ['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json'],
  },
  // Revision 3: the files an entry's imports select, which a module list from an earlier bundle
  // cannot name.
  DEPS: {
    invariant: 'Development and watch entry bundles follow the files their imports select, as a fresh build does',
    issue: 341,
    variants: [
      'dev eager glob gains a file',
      'dev lazy glob loses a file',
      'dev keys-only glob renames a file',
      'dev glob folder created',
      'dev watcher glob gains a file',
      'build watch glob gains a file',
    ],
  },
} as const satisfies Record<string, CaseGroup>;

export type GroupName = keyof typeof MATRIX;
export type Variant<G extends GroupName> = (typeof MATRIX)[G]['variants'][number];

/** A case's ID: the group and the variant's 1-based position, two digits. */
export function caseId(group: string, index: number): string {
  return `${group}-${String(index + 1).padStart(2, '0')}`;
}

/** Every case in ID order, as `ID: variant`. */
export function allCases(): readonly string[] {
  return Object.entries(MATRIX).flatMap(([group, { variants }]) =>
    variants.map((variant, index) => `${caseId(group, index)}: ${variant}`),
  );
}
