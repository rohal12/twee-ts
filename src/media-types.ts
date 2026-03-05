/**
 * Extension → MIME type mapping.
 * Ported from util.go:mediaTypeFromExt().
 */

import { extname } from 'node:path';

const MEDIA_TYPE_MAP: Record<string, string> = {
  // Audio
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wave: 'audio/wav',
  weba: 'audio/webm',

  // Fonts
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',

  // Images
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',

  // Metadata
  vtt: 'text/vtt',

  // Video
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
};

export function mediaTypeFromExt(ext: string): string {
  return MEDIA_TYPE_MAP[ext] ?? 'application/octet-stream';
}

export function mediaTypeFromFilename(filename: string): string {
  return mediaTypeFromExt(normalizedFileExt(filename));
}

export function normalizedFileExt(filename: string): string {
  const ext = extname(filename);
  if (!ext) return '';
  return ext.slice(1).toLowerCase();
}

/** Slugify a string for safe use as a DOM ID. */
export function slugify(original: string): string {
  return original.replace(/[\x00-\x20!-/:-@[-^`{-\x9f]+/g, '_');
}

/** Check if a file has a known type that should be processed. */
export function isKnownFileType(filename: string): boolean {
  const ext = normalizedFileExt(filename);
  return KNOWN_EXTENSIONS.has(ext);
}

const KNOWN_EXTENSIONS = new Set([
  'tw',
  'twee',
  'tw2',
  'twee2',
  'css',
  'js',
  'otf',
  'ttf',
  'woff',
  'woff2',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
  'aac',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'wave',
  'weba',
  'mp4',
  'ogv',
  'webm',
  'vtt',
]);

/** Font format hint for @font-face. */
export function fontFormatHint(ext: string): string {
  switch (ext) {
    case 'ttf':
      return 'truetype';
    case 'otf':
      return 'opentype';
    default:
      return ext;
  }
}
