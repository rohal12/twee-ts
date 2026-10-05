/**
 * All public interfaces for twee-ts.
 */

// --- Output modes ---

export type OutputMode = 'html' | 'twee3' | 'twee1' | 'twine2-archive' | 'twine1-archive' | 'json';

// --- Word count ---

export type WordCountMethod = 'tweego' | 'whitespace';

// --- Source input ---

export type InlineSource = { filename: string; content: string | Buffer };
export type SourceInput = string | InlineSource;

// --- Compile options ---

export interface CompileOptions {
  /** Files, directories, or inline sources to compile. */
  sources: SourceInput[];
  /**
   * Glob patterns for files to leave out of `sources`, matched against each file's
   * path relative to the working directory (as `stats.files` lists it). Modules are not affected.
   */
  exclude?: string[];
  /** Output mode. Default: 'html'. */
  outputMode?: OutputMode;
  /** Story format directory ID (e.g. 'sugarcube-2'). */
  formatId?: string;
  /** Name of the starting passage. Default: 'Start'. */
  startPassage?: string;
  /** Extra directories to search for story formats. */
  formatPaths?: string[];
  /** Also search TWEEGO_PATH env for formats. Default: true. */
  useTweegoPath?: boolean;
  /** Module files to inject into <head>. */
  modules?: string[];
  /** Raw HTML file to append to <head>. */
  headFile?: string;
  /** Trim passage whitespace. Default: true. */
  trim?: boolean;
  /** Twee2 compatibility mode. Default: false. */
  twee2Compat?: boolean;
  /** Enable debug/test mode option. Default: false. */
  testMode?: boolean;
  /** URLs to SFA-compatible index.json files for remote format lookup. */
  formatIndices?: string[];
  /**
   * Direct URLs to format.js files. Each URL's download is cached under that URL, and is
   * looked up before the downloads shared by name and version.
   */
  formatUrls?: string[];
  /** Disable remote format fetching. Default: false. */
  noRemote?: boolean;
  /**
   * Cancels the compile. Story format requests still in progress are aborted, and the compile
   * rejects with the signal's reason. `watch()` aborts its builds, and stops watching, when it aborts.
   */
  signal?: AbortSignal;
  /**
   * Milliseconds each story format request (an index or a format.js) may take before it fails
   * with a warning and the next source is tried. 0 turns the limit off. Default: 30000.
   */
  formatFetchTimeout?: number;
  /** Map alias tags to canonical special tags (e.g. { library: 'script' }). */
  tagAliases?: Record<string, string>;
  /** Emit source file and line as data- attributes on passage elements. Default: false. */
  sourceInfo?: boolean;
  /** Word counting method. Default: 'tweego'. */
  wordCountMethod?: WordCountMethod;
}

export interface CompileToFileOptions extends CompileOptions {
  /** Output file path. */
  outFile: string;
}

export interface WatchOptions extends CompileToFileOptions {
  /**
   * Called after each build is written, including one whose diagnostics report errors. Builds
   * run one at a time and are reported in order, each as it finishes, also while changes keep
   * arriving: the changes made during a build go into one follow-up build after it.
   */
  onBuild?: (result: CompileResult) => void;
  /**
   * Called when a build fails with a fatal error (nothing is written), when `onBuild` throws,
   * and when a watched path can't be watched (the other paths are still watched). An exception
   * thrown here is reported to the console, and watching goes on.
   */
  onError?: (error: Error) => void;
}

// --- Compile result ---

export type Diagnostic =
  | { level: 'warning'; message: string; file?: string; line?: number }
  | { level: 'error'; message: string; file?: string; line?: number; fatal?: boolean };

export interface CompileResult {
  /** The compiled output string (HTML, Twee, JSON, etc.). */
  output: string;
  /** The parsed story model (read-only after compilation). */
  story: ReadonlyStory;
  /** The format used for compilation (undefined for non-HTML modes). */
  format?: StoryFormatInfo;
  /** Collected diagnostics. */
  diagnostics: Diagnostic[];
  /** Compilation statistics. */
  stats: CompileStats;
}

export interface CompileStats {
  passages: number;
  storyPassages: number;
  words: number;
  files: string[];
}

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
  metadata?: PassageMetadata;
  source?: SourceLocation;
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

export type ReadonlyPassage = Readonly<Passage> & {
  readonly tags: readonly string[];
};

export type ReadonlyStory = Readonly<Omit<Story, 'passages' | 'twine1' | 'twine2'>> & {
  readonly passages: readonly ReadonlyPassage[];
  readonly twine1: Readonly<Omit<Twine1Metadata, 'settings'>> & {
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
  readonly trim?: boolean;
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
  readonly target?: PassageOutputTarget;
}

// --- Story format ---

export interface StoryFormatInfo {
  id: string;
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

/** The result of reading a format.js: its metadata, or why it cannot be used. */
export type FormatDecodeResult =
  { readonly ok: true; readonly data: Twine2FormatJSON } | { readonly ok: false; readonly reason: string };

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
  readonly signal?: AbortSignal;
  /** Milliseconds each request may take before it fails. 0 turns the limit off. Default: 30000. */
  readonly timeout?: number;
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
  readonly passages: readonly Passage[];
  readonly diagnostics: readonly Diagnostic[];
}

// --- Config file ---

export interface TweeTsConfig {
  sources?: string[];
  exclude?: string[];
  output?: string;
  outputMode?: OutputMode;
  formatId?: string;
  startPassage?: string;
  formatPaths?: string[];
  formatIndices?: string[];
  formatUrls?: string[];
  useTweegoPath?: boolean;
  modules?: string[];
  headFile?: string;
  trim?: boolean;
  twee2Compat?: boolean;
  testMode?: boolean;
  noRemote?: boolean;
  /** Milliseconds each story format request may take. 0 turns the limit off. Default: 30000. */
  formatFetchTimeout?: number;
  tagAliases?: Record<string, string>;
  sourceInfo?: boolean;
  wordCountMethod?: WordCountMethod;
}
