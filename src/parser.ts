/**
 * Parse lexer items into Passage[].
 * Ported from storyload.go:loadTwee().
 */
import type { Passage, Diagnostic } from './types.js';
import { ItemType } from './types.js';
import { tweeLexer } from './lexer.js';
import { twee2ToV3 } from './twee2-compat.js';
import { decodePassageMetadata } from './passage.js';
import {
  normalizeTweeSource,
  splitTweeFields,
  stripTrailingBlankLines,
  trimTweeSpace,
  tweeUnescape,
} from './twee-syntax.js';

export interface ParseOptions {
  /** Filename for diagnostics. */
  filename?: string | undefined;
  /**
   * Trim white space at both ends of passage content. Default: true. When false, the content is kept as
   * written except for its trailing blank lines, which the Twee 3 specification requires a reader to drop.
   */
  trim?: boolean | undefined;
  /** Enable Twee2 compatibility. Default: false. */
  twee2Compat?: boolean | undefined;
}

export interface ParseResult {
  passages: Passage[];
  diagnostics: Diagnostic[];
}

/**
 * Parse Twee source text into passages.
 *
 * The source is normalized first (see `normalizeTweeSource`): a leading UTF-8 BOM is removed, CRLF and bare CR
 * line endings become LF, and a BOM at the start of a later line, directly before `::` (left there by
 * concatenating files), is removed too, so that line stays a passage header.
 *
 * Names and tags are read as Tweego reads them: unescaped, then the name trimmed and the tags split at white
 * space, where white space is Go's `unicode.IsSpace` (see `isTweeSpace`).
 */
export function parseTwee(source: string, options: ParseOptions = {}): ParseResult {
  const { filename = '<inline>', trim = true, twee2Compat = false } = options;
  const diagnostics: Diagnostic[] = [];

  const normalized = normalizeTweeSource(source);
  const tweeSource = twee2Compat ? twee2ToV3(normalized) : normalized;

  const passages: Passage[] = [];
  let current: Passage | null = null;
  let pCount = 0;
  let lastType: ItemType = ItemType.EOF;

  const malformed = (line: number, problem: string): Diagnostic => ({
    level: 'error',
    message: `line ${line}: Malformed twee source; ${problem}.`,
    file: filename,
    line,
  });

  for (const item of tweeLexer(tweeSource)) {
    switch (item.type) {
      case ItemType.Error:
        diagnostics.push(malformed(item.line, item.val));
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
        current = { name: '', tags: [], text: '', source: { file: filename, line: item.line } };
        break;

      case ItemType.Name: {
        if (!current) break;
        const unescaped = tweeUnescape(item.val);
        const name = trimTweeSpace(unescaped.text);
        if (name.length === 0) {
          diagnostics.push(malformed(item.line, 'passage with no name'));
          return { passages, diagnostics };
        }
        if (unescaped.danglingBackslash) {
          diagnostics.push({
            level: 'warning',
            message: `line ${item.line}: The passage name ${JSON.stringify(name)} ends in a backslash that escapes nothing; it is dropped, as in Tweego. Write "\\\\" for a backslash.`,
            file: filename,
            line: item.line,
          });
        }
        current.name = name;
        break;
      }

      case ItemType.Tags: {
        if (!current) break;
        if (lastType !== ItemType.Name) {
          diagnostics.push(malformed(item.line, 'optional tags block must immediately follow the passage name'));
          return { passages, diagnostics };
        }
        // Strip the surrounding [ and ]. The lexer ends a tag block only at an unescaped `]`, so its text
        // never ends in a lone backslash.
        current.tags = splitTweeFields(tweeUnescape(item.val.slice(1, -1)).text);
        break;
      }

      case ItemType.Metadata: {
        if (!current) break;
        if (lastType !== ItemType.Name && lastType !== ItemType.Tags) {
          diagnostics.push(
            malformed(item.line, 'optional metadata block must immediately follow the passage name or tags block'),
          );
          return { passages, diagnostics };
        }
        const decoded = decodePassageMetadata(item.val);
        if (decoded.ok) {
          current.metadata = decoded.metadata;
          for (const issue of decoded.issues) {
            diagnostics.push({
              level: 'warning',
              message: `load ${filename}: line ${item.line}: Passage metadata: ${issue.message}.`,
              file: filename,
              line: item.line,
            });
          }
        } else {
          diagnostics.push({
            level: 'warning',
            message: `load ${filename}: line ${item.line}: Malformed twee source; could not decode metadata (reason: ${decoded.reason}).`,
            file: filename,
            line: item.line,
          });
        }
        break;
      }

      case ItemType.Content: {
        if (!current) break;
        current.text = trim ? trimTweeSpace(item.val) : stripTrailingBlankLines(item.val);
        break;
      }

      default: {
        const _exhaustive: never = item.type;
        diagnostics.push(malformed(item.line, `unhandled lexer item type ${String(_exhaustive)}`));
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
