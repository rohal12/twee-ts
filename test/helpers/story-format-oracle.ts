/**
 * V8 as the oracle for format.js decoding: the file is run in a fresh `vm` context that holds only
 * a stub `storyFormat`, and the objects it is called with are compared with what twee-ts reads
 * without running anything. Only trusted, generated or real-format fixtures are run.
 */
import { runInNewContext } from 'node:vm';

/** What running a format.js gives: the arguments of each `storyFormat()` call, or the error it threw. */
export type FormatRun = { readonly ok: true; readonly calls: readonly unknown[] } | { readonly ok: false };

/** Run `source` as a classic script with `storyFormat` and `window.storyFormat` stubbed. */
export function runFormatScript(source: string): FormatRun {
  const calls: unknown[] = [];
  const storyFormat = (format: unknown): void => {
    calls.push(format);
  };
  try {
    runInNewContext(source, { storyFormat, window: { storyFormat } }, { timeout: 5000 });
  } catch {
    return { ok: false };
  }
  return { ok: true, calls };
}

/**
 * A canonical text for a value read from a format object: key order (JavaScript's), `-0` and
 * every string are kept; function-valued properties, which twee-ts leaves out, are dropped. Works
 * across realms, so values from the `vm` context compare with the ones twee-ts builds.
 */
export function canonical(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => typeof v !== 'function');
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return `<${typeof value}>`;
}
