/**
 * twee-ts — TypeScript Twee-to-HTML compiler.
 * Public API exports.
 */

// Primary API
export { compile, compileIncremental, compileToFile, watch, TweeTsError } from './compiler.js';

// Story inspection, and the story model builder
export { storyInspect } from './inspect.js';
export { StoryBuilder } from './story.js';

// HTML decompiler
export { decompileHTML } from './html-parser.js';

// Lint
export { lint, formatLintReport } from './lint.js';

// Passage utilities
export { applyTagAliases } from './passage.js';

// Lower-level exports
export { TweeLexer, tweeLexer } from './lexer.js';
export { parseTwee } from './parser.js';
export { discoverFormats, getFormatSearchDirs, parseSemver, semverCompare } from './formats.js';
export { parseFormatJSON } from './format-decode.js';
export { generateIFID, validateIFID, createIFID } from './ifid.js';

// Config
export {
  loadConfig,
  loadConfigFile,
  validateConfig,
  unknownConfigKeyWarnings,
  scaffoldConfig,
  CONFIG_FILENAME,
} from './config.js';

// Remote formats
export { resolveRemoteFormat } from './format-resolution.js';
export { fetchDirectFormat } from './remote-formats.js';
export {
  getCacheDir,
  discoverCachedFormats,
  listCachedFormats,
  clearCachedFormats,
  getCacheSize,
} from './format-cache.js';

// Runtime values
export { ItemType } from './types.js';

// Types
export type {
  CompileOptions,
  CompileToFileOptions,
  DecompileOptions,
  WatchOptions,
  CompileResult,
  CompileStats,
  Diagnostic,
  Story,
  Passage,
  PassageMetadata,
  Twine1Metadata,
  Twine2Metadata,
  StoryFormatInfo,
  OutputMode,
  SourceInput,
  InlineSource,
  LexerItem,
  IFID,
  ReadonlyStory,
  ReadonlyPassage,
  SFAIndex,
  SFAIndexEntry,
  RemoteFetchOptions,
  RemoteResolveOptions,
  SourceLocation,
  TweeTsConfig,
  FileCacheEntry,
  TweeTsErrorCode,
  WordCountMethod,
  InspectOptions,
  PassageOutputTarget,
  PassageOmission,
  OmittingTag,
} from './types.js';
export type { CachedFormatEntry } from './format-cache.js';
export type { DecompileResult } from './html-parser.js';
export type { StoryMap, BrokenLink } from './inspect.js';
export type { LintResult } from './lint.js';
