/**
 * Which errors of a write to a stream mean the reader at the other end has gone, as opposed to a write that
 * failed (a full disk, an I/O error, a closed descriptor).
 *
 * Writing to a pipe or socket whose reader has closed is reported differently by each platform; libuv passes
 * the operating system's error on:
 *
 * - `EPIPE`: Linux and macOS (the signal is ignored by Node), and Windows named pipes whose other end is
 *   closing (`ERROR_NO_DATA`, `ERROR_PIPE_NOT_CONNECTED`).
 * - `EOF`: Windows named pipes whose other end is closed (`ERROR_BROKEN_PIPE`), which libuv reports as its
 *   own end-of-file code.
 * - `ENOTCONN`: macOS, for a pipe or socket pair whose peer is gone, where Linux gives `EPIPE`; Windows sockets.
 * - `ECONNRESET`, `ECONNABORTED`: the peer reset or aborted the connection (a socket as standard output).
 * - `ESHUTDOWN`: the socket was shut down for writing.
 * - `ERR_STREAM_DESTROYED`: Node's own error for a write after the stream has been destroyed, which follows
 *   any of the above.
 */
const READER_GONE: ReadonlySet<string> = new Set([
  'EPIPE',
  'EOF',
  'ENOTCONN',
  'ECONNRESET',
  'ECONNABORTED',
  'ESHUTDOWN',
  'ERR_STREAM_DESTROYED',
]);

/** Whether a stream write error is the reader going away, which ends the output quietly. */
export function isReaderGone(error: { readonly code?: unknown }): boolean {
  return typeof error.code === 'string' && READER_GONE.has(error.code);
}
