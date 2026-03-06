/**
 * twee-ts — TypeScript Twee-to-HTML compiler.
 * Public API exports.
 */

// Primary API
export { compile, compileIncremental, compileToFile, watch, TweeTsError } from './compiler.js';

// Story inspection (for unit testing)
export { storyInspect } from './inspect.js';

// Lint
export { lint, formatLintReport } from './lint.js';

// Passage utilities
export { applyTagAliases } from './passage.js';

// Lower-level exports
export { TweeLexer, tweeLexer } from './lexer.js';
export { parseTwee } from './parser.js';
export { discoverFormats, getFormatSearchDirs, parseSemver, semverCompare, parseFormatJSON } from './formats.js';
export { generateIFID, validateIFID } from './ifid.js';

// Config
export { loadConfig, loadConfigFile, validateConfig, scaffoldConfig, CONFIG_FILENAME } from './config.js';

// Remote formats
export {
  resolveRemoteFormat,
  fetchAndCacheFormat,
  fetchDirectFormat,
  getCacheDir,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
} from './remote-formats.js';

// Types
export type {
  CompileOptions,
  CompileToFileOptions,
  WatchOptions,
  CompileResult,
  CompileStats,
  Diagnostic,
  Story,
  Passage,
  PassageMetadata,
  StoryFormatInfo,
  OutputMode,
  SourceInput,
  InlineSource,
  LexerItem,
  ItemType,
  SFAIndex,
  SFAIndexEntry,
  SourceLocation,
  TweeTsConfig,
  FileCacheEntry,
  WordCountMethod,
} from './types.js';
export type { CachedFormatEntry } from './remote-formats.js';
export type { StoryMap, BrokenLink } from './inspect.js';
export type { LintResult } from './lint.js';
