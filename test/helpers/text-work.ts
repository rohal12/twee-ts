/**
 * Measures characters searched or sliced by the real string/regex operations, rather than elapsed time (#436).
 * This detects repeated suffix searches and repeated flattening of a growing string without depending on JIT,
 * garbage collection or other workers. It does not measure regex backtracking or indexed character reads.
 * Only synchronous work belongs inside `run`; every built-in is restored before returning or throwing.
 */
export function measureTextWork<T>(run: () => T): { readonly value: T; readonly work: number } {
  let work = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with native receivers via .call(), then restored by identity.
  const { indexOf, slice, endsWith } = String.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the native receiver via .call(), then restored by identity.
  const { exec } = RegExp.prototype;
  String.prototype.indexOf = function (this: string, search: string, position = 0): number {
    const result = indexOf.call(this, search, position);
    const from = Math.min(this.length, Math.max(0, Math.trunc(position) || 0));
    work += Math.max(1, (result === -1 ? this.length : result + search.length) - from);
    return result;
  };
  String.prototype.slice = function (this: string, start?: number, end?: number): string {
    const result = slice.call(this, start, end);
    work += result.length;
    return result;
  };
  String.prototype.endsWith = function (this: string, search: string, end?: number): boolean {
    // V8 can flatten a concatenation here, copying the entire receiver even for a one-character suffix (#463).
    work += this.length;
    return endsWith.call(this, search, end);
  };
  RegExp.prototype.exec = function (this: RegExp, text: string): RegExpExecArray | null {
    const from = this.global || this.sticky ? this.lastIndex : 0;
    const result = exec.call(this, text);
    const end = result === null ? (this.sticky ? from + 1 : text.length) : result.index + result[0].length;
    work += Math.max(1, end - from);
    return result;
  };
  try {
    const value = run();
    return { value, work };
  } finally {
    String.prototype.indexOf = indexOf;
    String.prototype.slice = slice;
    String.prototype.endsWith = endsWith;
    RegExp.prototype.exec = exec;
  }
}
