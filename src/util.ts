/**
 * Shared file I/O utilities.
 */
import { constants as bufferConstants } from 'node:buffer';
import { readFileSync, statSync } from 'node:fs';
import { parse as parsePath } from 'node:path';
import type { Diagnostic } from './types.js';
import { normalizeSourceText } from './source-text.js';

/** Whether `value` is an object other than an array, whose properties can be read by name. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Append every item to `target` (when there is one), one at a time: spreading them as arguments (`push(...items)`)
 * overflows the call stack once there are more than the engine takes, which input can make happen.
 */
export function pushAll<T>(target: T[] | undefined, items: Iterable<T>): void {
  if (target === undefined) return;
  for (const item of items) target.push(item);
}

/**
 * The known key that `key` most likely stands for: one that differs from it only in letter case, `-` or `_`
 * (`formatID`, `output-mode`), or undefined.
 */
export function similarKey(key: string, known: readonly string[]): string | undefined {
  const fold = (k: string): string => k.toLowerCase().replace(/[-_]/g, '');
  return known.find((candidate) => fold(candidate) === fold(key));
}

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

/** The character of each byte value. */
const WINDOWS_1252_CHARS = Array.from({ length: 256 }, (_, b) =>
  String.fromCharCode(b >= 0x80 && b <= 0x9f ? (WINDOWS_1252_C1[b - 0x80] ?? b) : b),
);

function decodeWindows1252(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => WINDOWS_1252_CHARS[b] ?? '').join('');
}

/** Byte order marks that name an encoding other than UTF-8. */
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF32LE_BOM = [0xff, 0xfe, 0x00, 0x00] as const;
const UTF32BE_BOM = [0x00, 0x00, 0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/** Bytes that cannot be decoded in the encoding their byte order mark names, or name an unsupported one. */
export class TextDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TextDecodeError';
  }
}

/** Little-endian UTF-16, which Node decodes without ICU (big-endian needs ICU, so it is swapped first). */
const utf16Decoder = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true });

/** UTF-16 text, its byte order mark kept as for UTF-8; a TextDecodeError naming the file when it is invalid. */
function decodeUTF16(bytes: Uint8Array, bigEndian: boolean, filename: string): string {
  const name = bigEndian ? 'UTF-16BE' : 'UTF-16LE';
  if (bytes.length % 2 !== 0) {
    throw new TextDecodeError(`read ${filename}: Invalid ${name}: an odd number of bytes.`);
  }
  // A swapped copy, so the caller's bytes are left alone.
  const littleEndian = bigEndian ? bytes.map((_, i) => bytes[i ^ 1] ?? 0) : bytes;
  try {
    return utf16Decoder.decode(littleEndian);
  } catch (cause) {
    throw new TextDecodeError(`read ${filename}: Invalid ${name}: an unpaired surrogate.`, { cause });
  }
}

/**
 * Decode bytes read from `filename` as text:
 *
 * - after a UTF-16 byte order mark (FF FE or FE FF, as PowerShell 5's `>` and Notepad write), as UTF-16; bytes
 *   that are not valid UTF-16 throw a {@link TextDecodeError};
 * - after a UTF-32 byte order mark, a {@link TextDecodeError}: UTF-32 is not supported;
 * - otherwise as UTF-8. Bytes that are not valid UTF-8 are decoded as Windows-1252 instead, with a warning naming
 *   the file, as Tweego does (`fileReadAllWithEncoding` in io.go), so a legacy file keeps its non-ASCII
 *   characters instead of losing them to U+FFFD.
 *
 * The text is returned as decoded: a leading BOM and CR line endings are kept (see {@link normalizeSourceText}).
 * More bytes than a string holds characters throw an `ERR_FS_FILE_TOO_LARGE` error.
 */
export function decodeText(bytes: Uint8Array, filename: string): DecodedText {
  checkTextSize(bytes.length, MAX_STRING_LENGTH);
  if (startsWith(bytes, UTF32LE_BOM) || startsWith(bytes, UTF32BE_BOM)) {
    throw new TextDecodeError(`read ${filename}: UTF-32 text is not supported; save the file as UTF-8.`);
  }
  if (startsWith(bytes, UTF16LE_BOM)) return { text: decodeUTF16(bytes, false, filename), diagnostics: [] };
  if (startsWith(bytes, UTF16BE_BOM)) return { text: decodeUTF16(bytes, true, filename), diagnostics: [] };
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
 * Read a text file: decode it with {@link decodeText} (UTF-16 after a UTF-16 byte order mark, else UTF-8, or
 * Windows-1252 when it is not valid UTF-8), strip a leading BOM and convert CRLF and bare CR line endings to LF.
 * This is the one path every file read as text goes through: sources, modules, the head file, story formats and
 * the config file.
 *
 * @param diagnostics Receives the warning when the file is not valid UTF-8. Without it, the file is decoded
 *   the same way and the warning is dropped.
 * @throws When the file cannot be read or is larger than a string can hold (`ERR_FS_FILE_TOO_LARGE`), or a
 *   {@link TextDecodeError} when it cannot be decoded.
 */
export function readUTF8(filename: string, diagnostics?: Diagnostic[]): string {
  // Checked before reading, so a file too large to hold as text fails at once rather than after reading it.
  checkTextSize(statSync(filename).size, MAX_STRING_LENGTH);
  const decoded = decodeText(readFileSync(filename), filename);
  pushAll(diagnostics, decoded.diagnostics);
  return normalizeSourceText(decoded.text);
}

/** Read a file as base64. */
export function readBase64(filename: string): string {
  // Base64 writes 4 characters for every 3 bytes.
  checkTextSize(statSync(filename).size, Math.floor(MAX_STRING_LENGTH / 4) * 3, ' as base64');
  return readFileSync(filename).toString('base64');
}

/** The most UTF-16 code units a JavaScript string holds in this engine (2^29 - 24 in V8). */
export const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;

/**
 * Throws, as Node.js does for a file too large to read (`ERR_FS_FILE_TOO_LARGE`), when `size` bytes are more than
 * `limit`: text decoded from more bytes than a string holds code units may not fit in one (UTF-8 and Windows-1252
 * give at most one code unit per byte), and the engine's own error would not say so.
 */
function checkTextSize(size: number, limit: number, as = ''): void {
  if (size <= limit) return;
  const error = new Error(
    `File size (${String(size)} bytes) is greater than the ${String(limit)} bytes twee-ts can read${as}, ` +
      `as a JavaScript string holds at most ${String(MAX_STRING_LENGTH)} characters`,
  );
  throw Object.assign(error, { code: 'ERR_FS_FILE_TOO_LARGE' });
}

/**
 * The base name of a file up to its first dot, as Tweego names media passages and font families
 * (`strings.Split(filepath.Base(filename), ".")[0]`): `bg.night.png` gives `bg`. A name that starts with dots
 * keeps them and ends at the next dot (`.hidden.png` gives `.hidden`), where Tweego would give an empty name.
 */
export function fileStem(filename: string): string {
  const base = parsePath(filename).base;
  let leadingDots = 0;
  while (base[leadingDots] === '.') leadingDots++;
  const dot = base.indexOf('.', leadingDots);
  return dot === -1 ? base : base.slice(0, dot);
}
