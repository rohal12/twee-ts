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
  /** Direct URLs to format.js files. */
  formatUrls?: string[];
  /** Disable remote format fetching. Default: false. */
  noRemote?: boolean;
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
  /** Called after each successful rebuild. */
  onBuild?: (result: CompileResult) => void;
  /** Called on build errors. */
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

// --- Incremental compilation cache ---

export interface FileCacheEntry {
  readonly mtimeMs: number;
  readonly passages: readonly Passage[];
  readonly diagnostics: readonly Diagnostic[];
}

// --- Config file ---

export interface TweeTsConfig {
  sources?: string[];
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
  tagAliases?: Record<string, string>;
  sourceInfo?: boolean;
  wordCountMethod?: WordCountMethod;
}
