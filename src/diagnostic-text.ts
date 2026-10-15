/**
 * A diagnostic as one line of text, for the places that print them: the command line, the lint report and the
 * build plugins. Depends on nothing else in twee-ts but the Diagnostic type.
 */
import type { Diagnostic } from './types.js';

/** Printable notation for C0/C1 terminal controls; callers may keep their own line separators. */
export function escapeTerminalControls(text: string, keepNewlines = false): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
    keepNewlines && character === '\n' ? character : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The message with where it happened in front: `file:line: message`, or `file: message` when no line is known.
 * The parser starts its messages with "line N: "; the location already says it. A message that already
 * names the file as its location (`load a.tw: line 3: …`, `read a.tw: …`, `path a.tw: …`) is given as it is, and so
 * is one without a file. A file named in passing ("It replaces the one from a.tw (line 7)") is not a location.
 */
export function formatDiagnostic(d: Readonly<Diagnostic>): string {
  const message = escapeTerminalControls(d.message);
  if (!d.file || d.message.includes(`${d.file}:`)) return message;
  const file = escapeTerminalControls(d.file);
  if (!d.line) return `${file}: ${message}`;
  return `${file}:${d.line}: ${message.replace(/^line \d+: /, '')}`;
}
