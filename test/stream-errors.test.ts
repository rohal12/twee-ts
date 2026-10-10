import { describe, expect, it } from 'vitest';
import { isReaderGone } from '../src/stream-errors.js';

describe('isReaderGone', () => {
  it.each([
    // The reader went away: Linux and macOS, Windows named pipes, sockets, and Node's follow-up error.
    ['EPIPE', true],
    ['EOF', true],
    ['ENOTCONN', true],
    ['ECONNRESET', true],
    ['ECONNABORTED', true],
    ['ESHUTDOWN', true],
    ['ERR_STREAM_DESTROYED', true],
    // A write that failed: reported.
    ['ENOSPC', false],
    ['EIO', false],
    ['EBADF', false],
    ['EACCES', false],
    ['EFBIG', false],
    ['EDQUOT', false],
    ['EAGAIN', false],
    ['EINVAL', false],
    ['ETIMEDOUT', false],
    ['ERR_STREAM_WRITE_AFTER_END', false],
    ['epipe', false],
  ])('classifies %s as reader gone: %s', (code, gone) => {
    expect(isReaderGone({ code })).toBe(gone);
  });

  it.each([[undefined], [null], [32], [{}]])('is not fooled by a code of %j', (code) => {
    expect(isReaderGone({ code })).toBe(false);
  });

  it('classifies an error without a code as a failure', () => {
    expect(isReaderGone({})).toBe(false);
  });
});
