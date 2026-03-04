/**
 * All public interfaces for twee-ts.
 */

// --- Output modes ---

export type OutputMode =
  | 'html'
  | 'twee3'
  | 'twee1'
  | 'twine2-archive'
  | 'twine1-archive'
  | 'json';

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

export interface Diagnostic {
  level: 'warning' | 'error';
  message: string;
  file?: string;
  line?: number;
}

export interface CompileResult {
  /** The compiled output string (HTML, Twee, JSON, etc.). */
  output: string;
  /** The parsed story model. */
  story: Story;
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

export interface PassageMetadata {
  position?: string;
  size?: string;
}

export interface Passage {
  name: string;
  tags: string[];
  text: string;
  metadata?: PassageMetadata;
}

// --- Story ---

export interface Twine1Metadata {
  settings: Map<string, string>;
}

export interface Twine2Metadata {
  format: string;
  formatVersion: string;
  options: Map<string, boolean>;
  start: string;
  tagColors: Map<string, string>;
  zoom: number;
}

export interface Story {
  name: string;
  ifid: string;
  passages: Passage[];
  legacyIFID: string;
  twine1: Twine1Metadata;
  twine2: Twine2Metadata;
}

// --- Story format ---

export interface StoryFormatInfo {
  id: string;
  filename: string;
  isTwine2: boolean;
  name: string;
  version: string;
  proofing: boolean;
}

export interface Twine2FormatJSON {
  name: string;
  version: string;
  proofing?: boolean;
  source: string;
}

// --- Lexer ---

export const enum ItemType {
  Error = 0,
  EOF = 1,
  Header = 2,
  Name = 3,
  Tags = 4,
  Metadata = 5,
  Content = 6,
}

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
}
