/**
 * All public interfaces for twee-ts.
 */

// --- Output modes ---

export type OutputMode = 'html' | 'twee3' | 'twee1' | 'twine2-archive' | 'twine1-archive' | 'json';

// --- Word count ---

export type WordCountMethod = 'tweego' | 'whitespace';

// --- Source input ---

export interface InlineSource {
  filename: string;
  content: string | Buffer;
}
export type SourceInput = string | InlineSource;

// --- Compile options ---

/**
 * The options of `compile()` and the functions built on it. Only `sources` is required; an optional
 * property set to `undefined` means the same as leaving it out.
 *
 * - `formatId` and `startPassage` win over StoryData's `format`/`format-version` and `start`; without
 *   either, the default is 'sugarcube-2' and 'Start'.
 * - `formatUrls` and `formatIndices` take absolute `http:`/`https:` URLs. The local formats are
 *   consulted first, then each format URL (requested again, conditionally, on every online build),
 *   then each index, then the Story Formats Archive. A download is cached for the URL or index it
 *   came from, and `noRemote` builds still use those cached downloads.
 * - A missing or unreadable `headFile` is a TweeTsError (`INPUT_UNAVAILABLE`); a negative
 *   `formatFetchTimeout` one with `INVALID_OPTIONS`.
 */
export interface CompileOptions {
  /**
   * Files, directories, or inline sources to compile. Directories are walked
   * recursively; inside one, a symbolic link to a file is read, but a link to a
   * directory is not followed (as in Tweego).
   */
  sources: readonly SourceInput[];
  /**
   * Glob patterns for files to leave out of `sources`, matched against each file's
   * path relative to the working directory (as `stats.files` lists it). Not the modules or head file.
   */
  exclude?: readonly string[] | undefined;
  /** Output mode. Default: 'html'. */
  outputMode?: OutputMode | undefined;
  /** Story format ID (e.g. 'sugarcube-2'). Default: StoryData's format, else 'sugarcube-2'. */
  formatId?: string | undefined;
  /** Name of the starting passage. Default: StoryData's `start`, else 'Start'. */
  startPassage?: string | undefined;
  /** Extra directories to search for story formats. */
  formatPaths?: readonly string[] | undefined;
  /** Also search TWEEGO_PATH env for formats. Default: true. */
  useTweegoPath?: boolean | undefined;
  /** Module files (JS, CSS or fonts) to inject into the head of HTML output. */
  modules?: readonly string[] | undefined;
  /** Raw HTML file to append to the head of HTML output. */
  headFile?: string | undefined;
  /** Trim white space at both ends of passage text, in Twee and HTML sources. Default: true. */
  trim?: boolean | undefined;
  /** Twee2 compatibility mode (`.tw2` and `.twee2` files always use it). Default: false. */
  twee2Compat?: boolean | undefined;
  /** Add the `debug` option to the story's options. Default: false. */
  testMode?: boolean | undefined;
  /** URLs of SFA-compatible index.json files, consulted after `formatUrls`. */
  formatIndices?: readonly string[] | undefined;
  /** URLs of format.js files, consulted after the local formats and before `formatIndices`. */
  formatUrls?: readonly string[] | undefined;
  /** Download no story formats (cached downloads are still used). Default: false. */
  noRemote?: boolean | undefined;
  /**
   * Cancels the compile. Story format requests still in progress are aborted, and the compile
   * rejects with the signal's reason. `watch()` aborts its builds, and stops watching, when it aborts.
   */
  signal?: AbortSignal | undefined;
  /**
   * Milliseconds each story format request (an index or a format.js) may take before it fails
   * with a warning and the next source is tried. 0 turns the limit off. Default: 30000.
   */
  formatFetchTimeout?: number | undefined;
  /** Map alias tags to target tags (e.g. { library: 'script' }); each passage with an alias gets the target too. */
  tagAliases?: Record<string, string> | undefined;
  /** Emit source file and line as data- attributes on passage elements. Default: false. */
  sourceInfo?: boolean | undefined;
  /** Word counting method. Default: 'tweego'. */
  wordCountMethod?: WordCountMethod | undefined;
}

export interface CompileToFileOptions extends CompileOptions {
  /**
   * Output file path. It is never read as a source, even inside a source folder or
   * reached through a symbolic link. Naming it as a source, a module or the head
   * file (in any output mode, by any spelling, or as a hard link) is a TweeTsError
   * (`OUTPUT_IS_INPUT`), and nothing is written. So is an existing file of a source
   * type inside a source folder that is not an earlier twee-ts build. How it is
   * written depends on what is there: see docs/cli.md, "Output safety".
   */
  outFile: string;
}

export interface WatchOptions extends CompileToFileOptions {
  /**
   * Called after each build is written, including one whose diagnostics report errors. Builds
   * run one at a time and are reported in order, each as it finishes, also while changes keep
   * arriving: the changes made during a build go into one follow-up build after it.
   */
  onBuild?: ((result: CompileResult) => void) | undefined;
  /**
   * Called when a build fails with a fatal error (nothing is written), when `onBuild` throws,
   * and when a watched path can't be watched (the other paths are still watched). An exception
   * thrown here is reported to the console, and watching goes on. A TweeTsError no edit to the
   * sources can fix (`OUTPUT_IS_INPUT`, `INVALID_OPTIONS`) also stops watching.
   */
  onError?: ((error: Error) => void) | undefined;
}

// --- Compile result ---

/**
 * A warning or an error a build reports. `file` and `line` say where, when known. (`fatal` is not set
 * by twee-ts: a build that cannot go on throws a TweeTsError instead.)
 */
export type Diagnostic =
  | { level: 'warning'; message: string; file?: string; line?: number }
  | { level: 'error'; message: string; file?: string; line?: number; fatal?: boolean };

export interface CompileResult {
  /** The compiled output string (HTML, Twee, JSON, etc.). */
  output: string;
  /** The story model, read-only. */
  story: ReadonlyStory;
  /** The format used for compilation (undefined for non-HTML modes). */
  format?: StoryFormatInfo | undefined;
  /** Warnings and errors. The output is built even when some are errors; check them. */
  diagnostics: Diagnostic[];
  /** Compilation statistics. */
  stats: CompileStats;
}

export interface CompileStats {
  /** Every passage. */
  passages: number;
  /** The passages that are not info passages (special names, script, stylesheet, `Twine.*` tags…). */
  storyPassages: number;
  /** The word count of the story passages (see `wordCountMethod`). */
  words: number;
  /** The source files loaded, in order, as paths relative to the working directory when inside it. */
  files: string[];
  /** The module files and the head file the build injected (HTML output only), as Tweego's "External files". */
  externalFiles?: string[];
}

/**
 * Why a TweeTsError stopped a build:
 * - `OUTPUT_IS_INPUT`: the output would overwrite an input (a source, module, head file, config file or story
 *   format), or a source file of the output's type found in a source folder.
 * - `INPUT_UNAVAILABLE`: an input the input policy makes fatal (the head file, the config file) can't be used.
 * - `INVALID_OPTIONS`: an option is out of range, or needs a newer Node.js.
 * - `BUILD_FAILED`: anything else (no story format for HTML output, say).
 */
export type TweeTsErrorCode = 'OUTPUT_IS_INPUT' | 'INPUT_UNAVAILABLE' | 'INVALID_OPTIONS' | 'BUILD_FAILED';

// --- Passage ---

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
}

export interface PassageMetadata {
  position?: string;
  size?: string;
  [key: string]: string | undefined;
}

export interface Passage {
  name: string;
  tags: string[];
  text: string;
  metadata?: PassageMetadata | undefined;
  source?: SourceLocation | undefined;
}

// --- Branded types ---

export type IFID = string & { readonly __brand: 'IFID' };

// --- Story ---

export interface Twine1Metadata {
  settings: Map<string, string>;
}

export interface Twine2Metadata {
  format: string;
  formatVersion: string;
  options: Map<string, boolean>;
  start: string;
  tags: string;
  tagColors: Map<string, string>;
  zoom: number;
}

export interface Story {
  name: string;
  ifid: IFID;
  passages: Passage[];
  legacyIFID: IFID;
  twine1: Twine1Metadata;
  twine2: Twine2Metadata;
}

// --- Readonly story (post-construction) ---

export type ReadonlyPassage = Readonly<Omit<Passage, 'tags' | 'metadata'>> & {
  readonly tags: readonly string[];
  readonly metadata?: Readonly<PassageMetadata> | undefined;
};

export type ReadonlyStory = Readonly<Omit<Story, 'passages' | 'twine1' | 'twine2'>> & {
  readonly passages: readonly ReadonlyPassage[];
  readonly twine1: {
    readonly settings: ReadonlyMap<string, string>;
  };
  readonly twine2: Readonly<Omit<Twine2Metadata, 'options' | 'tagColors'>> & {
    readonly options: ReadonlyMap<string, boolean>;
    readonly tagColors: ReadonlyMap<string, string>;
  };
};

// --- Passage omission (why an output leaves a passage out) ---

export type OmittingTag = 'Twine.private' | 'script' | 'stylesheet';

export type PassageOmission =
  | { readonly kind: 'special-name'; readonly name: 'StoryData' | 'StoryTitle' }
  | { readonly kind: 'tag'; readonly tag: OmittingTag }
  | { readonly kind: 'empty-story-settings' };

/** The output whose rules decide which passages a story emits as passages. */
export type PassageOutputTarget = 'twine1' | 'twine2';

// --- HTML decompile ---

export interface DecompileOptions {
  /**
   * Trim whitespace at both ends of passage text (and of the Twine 2 story stylesheet and script),
   * as the Twee lexer does. When false, the stored text is kept exactly. Default: true.
   */
  readonly trim?: boolean | undefined;
}

// --- Story inspection ---

export interface InspectOptions {
  /**
   * Check link destinations against this output's passage rules. A link to a passage that the
   * output leaves out (in Twine 2: `script`, `stylesheet` and `Twine.private` passages,
   * StoryData, StoryTitle and an empty StorySettings; in Twine 1: `Twine.private` passages) is
   * then a broken link, and says why. The passages it leaves out also give no links, as their
   * text never reaches the player, except script passages, which Twine 2 output runs. Without a
   * target, every source passage gives links, and a link is broken only when no passage has its
   * name.
   */
  readonly target?: PassageOutputTarget | undefined;
}

// --- Story format ---

export interface StoryFormatInfo {
  id: string;
  /**
   * The format's file (format.js or header.html): in a local format folder, in the download cache,
   * or, for a download the cache could not store, the URL it was downloaded from.
   */
  filename: string;
  isTwine2: boolean;
  name: string;
  version: string;
  proofing: boolean;
  author?: string;
  description?: string;
  image?: string;
  url?: string;
  license?: string;
}

/**
 * The story format a compile asks for: a directory-style ID (e.g. 'sugarcube-2', which names
 * a format and a major version) or a Twine 2 format name with a version (as StoryData has it).
 */
export type FormatRequest =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'name'; readonly name: string; readonly version: string };

export interface Twine2FormatJSON {
  name: string;
  version: string;
  proofing?: boolean;
  source: string;
  author?: string;
  description?: string;
  image?: string;
  url?: string;
  license?: string;
}

/**
 * The result of reading a format.js: its metadata, with notes on what was left out (a
 * function-valued property such as Harlowe's `setup`, a field of the wrong type), or why it cannot
 * be used.
 */
export type FormatDecodeResult =
  | { readonly ok: true; readonly data: Twine2FormatJSON; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * A parsed SemVer version. Build metadata is dropped, since it takes no part in precedence.
 * Each prerelease identifier is kept as written ('beta', '1').
 */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

// --- Lexer ---

export const ItemType = {
  Error: 0,
  EOF: 1,
  Header: 2,
  Name: 3,
  Tags: 4,
  Metadata: 5,
  Content: 6,
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

export interface LexerItem {
  type: ItemType;
  line: number;
  pos: number;
  val: string;
}

// --- Story Format Archive (SFA) ---

export interface SFAIndexEntry {
  name: string;
  version: string;
  proofing: boolean;
  files: string[];
  checksums: Record<string, string>;
}

export interface SFAIndex {
  twine1: SFAIndexEntry[];
  twine2: SFAIndexEntry[];
}

/** Options for the network requests that fetch story formats and their indices. */
export interface RemoteFetchOptions {
  /** Aborts the requests; the call then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds each request may take before it fails. 0 turns the limit off. Default: 30000. */
  readonly timeout?: number | undefined;
}

// --- Incremental compilation cache ---

export interface FileCacheEntry {
  readonly mtimeMs: number;
  /**
   * Identity of the parse options (`trim`, `twee2Compat`) the entry was parsed with. An entry is
   * reused only when this matches the current options; an entry without it is treated as stale
   * and reparsed. The value is opaque: leave it to twee-ts to set.
   */
  readonly parseOptionsKey?: string;
  /**
   * What else identifies the file's contents besides `mtimeMs` (its size, inode and status-change
   * time), so a write that keeps the modification time is still seen. An entry is reused only when
   * this matches too; an entry without it is treated as stale. The value is opaque: leave it to
   * twee-ts to set.
   */
  readonly signature?: string;
  readonly passages: readonly Passage[];
  readonly diagnostics: readonly Diagnostic[];
}

// --- Config file ---

export interface TweeTsConfig {
  sources?: string[] | undefined;
  exclude?: string[] | undefined;
  output?: string | undefined;
  outputMode?: OutputMode | undefined;
  formatId?: string | undefined;
  startPassage?: string | undefined;
  formatPaths?: string[] | undefined;
  formatIndices?: string[] | undefined;
  formatUrls?: string[] | undefined;
  useTweegoPath?: boolean | undefined;
  modules?: string[] | undefined;
  headFile?: string | undefined;
  trim?: boolean | undefined;
  twee2Compat?: boolean | undefined;
  testMode?: boolean | undefined;
  noRemote?: boolean | undefined;
  /** Milliseconds each story format request may take. 0 turns the limit off. Default: 30000. */
  formatFetchTimeout?: number | undefined;
  tagAliases?: Record<string, string> | undefined;
  sourceInfo?: boolean | undefined;
  wordCountMethod?: WordCountMethod | undefined;
}
