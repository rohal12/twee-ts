/** The text of data passed to `writeFileSync`: a string as it is, bytes decoded as UTF-8. */
export function textOf(data: string | NodeJS.ArrayBufferView): string {
  return typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
}
