/**
 * Parse lexer items into Passage[].
 * Ported from storyload.go:loadTwee().
 */
import type { Passage, PassageMetadata, Diagnostic } from './types.js';
import { ItemType } from './types.js';
import { tweeLexer } from './lexer.js';
import { tweeUnescape } from './escape.js';
import { twee2ToV3 } from './twee2-compat.js';

export interface ParseOptions {
  /** Filename for diagnostics. */
  filename?: string;
  /** Trim whitespace from passage content. Default: true. */
  trim?: boolean;
  /** Enable Twee2 compatibility. Default: false. */
  twee2Compat?: boolean;
}

export interface ParseResult {
  passages: Passage[];
  diagnostics: Diagnostic[];
}

/**
 * Parse Twee source text into passages.
 */
export function parseTwee(source: string, options: ParseOptions = {}): ParseResult {
  const { filename = '<inline>', trim = true, twee2Compat = false } = options;
  const diagnostics: Diagnostic[] = [];

  if (twee2Compat) {
    source = twee2ToV3(source);
  }

  const passages: Passage[] = [];
  let current: Passage | null = null;
  let pCount = 0;
  let lastType: ItemType = ItemType.EOF;

  for (const item of tweeLexer(source)) {
    switch (item.type) {
      case ItemType.Error:
        diagnostics.push({
          level: 'error',
          message: `line ${item.line}: Malformed twee source; ${item.val}.`,
          file: filename,
          line: item.line,
        });
        // Fatal: return what we have
        return { passages, diagnostics };

      case ItemType.EOF:
        if (pCount > 0 && current) {
          passages.push(current);
        }
        return { passages, diagnostics };

      case ItemType.Header:
        pCount++;
        if (pCount > 1 && current) {
          passages.push(current);
        }
        current = { name: '', tags: [], text: '' };
        break;

      case ItemType.Name: {
        if (!current) break;
        const name = tweeUnescape(item.val).trim();
        if (name.length === 0) {
          diagnostics.push({
            level: 'error',
            message: `line ${item.line}: Malformed twee source; passage with no name.`,
            file: filename,
            line: item.line,
          });
          return { passages, diagnostics };
        }
        current.name = name;
        break;
      }

      case ItemType.Tags: {
        if (!current) break;
        if (lastType !== ItemType.Name) {
          diagnostics.push({
            level: 'error',
            message: `line ${item.line}: Malformed twee source; optional tags block must immediately follow the passage name.`,
            file: filename,
            line: item.line,
          });
          return { passages, diagnostics };
        }
        // Strip the surrounding [ and ]
        const inner = item.val.slice(1, -1);
        current.tags = tweeUnescape(inner).split(/\s+/).filter(Boolean);
        break;
      }

      case ItemType.Metadata: {
        if (!current) break;
        if (lastType !== ItemType.Name && lastType !== ItemType.Tags) {
          diagnostics.push({
            level: 'error',
            message: `line ${item.line}: Malformed twee source; optional metadata block must immediately follow the passage name or tags block.`,
            file: filename,
            line: item.line,
          });
          return { passages, diagnostics };
        }
        try {
          const raw: unknown = JSON.parse(item.val);
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new Error('expected a JSON object');
          }
          const parsed = raw as Record<string, unknown>;
          const meta: PassageMetadata = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
              meta[key] = value;
            }
          }
          current.metadata = meta;
        } catch (e) {
          diagnostics.push({
            level: 'warning',
            message: `load ${filename}: line ${item.line}: Malformed twee source; could not decode metadata (reason: ${e instanceof Error ? e.message : String(e)}).`,
            file: filename,
            line: item.line,
          });
        }
        break;
      }

      case ItemType.Content: {
        if (!current) break;
        if (trim) {
          current.text = item.val.trim();
        } else {
          // Per spec: trailing blank lines MUST be stripped regardless of trim option
          current.text = item.val.replace(/\n\s*$/, '');
        }
        break;
      }

      default: {
        const _exhaustive: never = item.type;
        diagnostics.push({
          level: 'error',
          message: `line ${item.line}: Unhandled lexer item type: ${_exhaustive}.`,
          file: filename,
          line: item.line,
        });
        return { passages, diagnostics };
      }
    }

    lastType = item.type;
  }

  // Shouldn't reach here (EOF is always emitted), but just in case:
  if (pCount > 0 && current) {
    passages.push(current);
  }
  return { passages, diagnostics };
}
