/**
 * Shared file I/O utilities.
 */
import { readFileSync } from 'node:fs';
import { parse as parsePath } from 'node:path';
import type { Diagnostic } from './types.js';
import { normalizeSourceText } from './source-text.js';

/** Text decoded from bytes, with the warning when the bytes were not valid UTF-8. */
export interface DecodedText {
  readonly text: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The charset assumed for text that is not valid UTF-8, as Tweego assumes it. */
const FALLBACK_CHARSET = 'windows-1252';

/**
 * Throws on invalid UTF-8 instead of replacing bytes with U+FFFD. `ignoreBOM` keeps a leading BOM in the
 * text, as `readFileSync(file, 'utf-8')` did, so {@link normalizeSourceText} strips exactly one.
 */
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The code points of the Windows-1252 bytes 0x80 to 0x9F, from the WHATWG Encoding Standard. The five bytes
 * Windows-1252 leaves undefined map to the C1 control with the same number, as the standard and Go's charmap
 * do. Every other byte is the code point with the same number.
 *
 * Decoded by hand, because Node's `TextDecoder('windows-1252')` decodes as ISO-8859-1 in some releases
 * (Node 22.18 turns 0x80 into U+0080 instead of €), and builds without ICU lack it.
 */
const WINDOWS_1252_C1 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
] as const;

function decodeWindows1252(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // Chunked, so String.fromCharCode never gets more arguments than the engine allows.
  for (let start = 0; start < bytes.length; start += 0x2000) {
    const codes = Array.from(bytes.subarray(start, start + 0x2000), (b) =>
      b >= 0x80 && b <= 0x9f ? (WINDOWS_1252_C1[b - 0x80] ?? b) : b,
    );
    chunks.push(String.fromCharCode(...codes));
  }
  return chunks.join('');
}

/**
 * Decode bytes read from `filename` as UTF-8. Bytes that are not valid UTF-8 are decoded as Windows-1252
 * instead, with a warning naming the file, as Tweego does (`fileReadAllWithEncoding` in io.go), so a legacy
 * file keeps its non-ASCII characters instead of losing them to U+FFFD.
 *
 * The text is returned as decoded: a leading BOM and CR line endings are kept (see {@link normalizeSourceText}).
 */
export function decodeText(bytes: Uint8Array, filename: string): DecodedText {
  try {
    return { text: utf8Decoder.decode(bytes), diagnostics: [] };
  } catch {
    return {
      text: decodeWindows1252(bytes),
      diagnostics: [
        {
          level: 'warning',
          message: `read ${filename}: Invalid UTF-8; assuming charset is ${FALLBACK_CHARSET}.`,
          file: filename,
        },
      ],
    };
  }
}

/**
 * Read a text file: decode it with {@link decodeText} (UTF-8, or Windows-1252 when it is not valid UTF-8),
 * strip a leading BOM and convert CRLF and bare CR line endings to LF. This is the one path every file read
 * as text goes through: sources, modules, the head file, story formats and the config file.
 *
 * @param diagnostics Receives the warning when the file is not valid UTF-8. Without it, the file is decoded
 *   the same way and the warning is dropped.
 * @throws When the file cannot be read.
 */
export function readUTF8(filename: string, diagnostics?: Diagnostic[]): string {
  const decoded = decodeText(readFileSync(filename), filename);
  diagnostics?.push(...decoded.diagnostics);
  return normalizeSourceText(decoded.text);
}

/** Read a file as base64. */
export function readBase64(filename: string): string {
  return readFileSync(filename).toString('base64');
}

/** Get the filename without extension, a dotfile keeps its whole name. */
export function baseNameWithoutExt(filename: string): string {
  return parsePath(filename).name;
}
