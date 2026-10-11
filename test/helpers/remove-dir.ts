import { rmSync } from 'node:fs';

/**
 * Removes a test's folder once nothing writes into it any more. Windows deletes a file only when the last handle to
 * it closes, and an antivirus or indexer may still hold one that was just written: the folder holding it is not empty
 * for a moment (EBUSY, EPERM, ENOTEMPTY), so there the removal is retried, as Node.js retries those. Elsewhere a
 * failure means a writer still at work (#436), and is reported rather than retried away.
 */
export function removeDir(dir: string): void {
  const retries = process.platform === 'win32' ? { maxRetries: 10, retryDelay: 100 } : {};
  rmSync(dir, { recursive: true, force: true, ...retries });
}
