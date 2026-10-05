/**
 * Shared file I/O utilities.
 */
import { readFileSync } from 'node:fs';
import { parse as parsePath } from 'node:path';
import { normalizeSourceText } from './source-text.js';

/** Read a file as UTF-8 with BOM stripping and line ending normalization. */
export function readUTF8(filename: string): string {
  return normalizeSourceText(readFileSync(filename, 'utf-8'));
}

/** Read a file as base64. */
export function readBase64(filename: string): string {
  return readFileSync(filename).toString('base64');
}

/** Get the filename without extension, falling back to the full basename for dotfiles. */
export function baseNameWithoutExt(filename: string): string {
  const { name, ext } = parsePath(filename);
  return name || ext;
}
