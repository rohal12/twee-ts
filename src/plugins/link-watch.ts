/**
 * Tells a bundler's build watch that a link the story's inputs are reached through was pointed elsewhere, when the
 * bundler's own watcher can't. Rollup's watcher (chokidar) follows a registered link and watches the file it leads to,
 * so replacing the link, or a hop of a chain of links, raises nothing. The link's folder is watched here instead (not
 * recursively, so what the build writes below it is not reported), and a change of any link starts a build the way an
 * edit of a registered file does: by touching a file the plugin has registered with the bundler.
 */
import { mkdtempSync, readlinkSync, rmSync, statSync, utimesSync, watch, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** How long a burst of file system events settles before the links are read again (a link is replaced in two steps). */
const SETTLE_MS = 30;

export interface LinkWatch {
  /** The file to register with the bundler's watcher: written when a link changed, with the number of changes so far. */
  readonly signal: string;
  /** Watches `links` (platform paths) from now on, instead of the links watched before. */
  watch(links: readonly string[]): void;
  /** Stops watching and removes the signal file. */
  close(): void;
}

/** Where a link leads (as written), or nothing when it is no link or does not exist. */
function destination(link: string): string | undefined {
  try {
    return readlinkSync(link);
  } catch {
    return undefined;
  }
}

/**
 * A watch of links that touches its signal file when one of them leads elsewhere, or appears or disappears. The watch
 * is a refinement of the build watch: without a temporary folder to write the signal file in (a missing or read-only
 * TMPDIR), there is none, and a retargeted link is read with the next build something else starts.
 */
export function createLinkWatch(): LinkWatch | undefined {
  let folder: string | undefined;
  let signal: string;
  try {
    folder = mkdtempSync(join(tmpdir(), 'twee-ts-links-'));
    signal = join(folder, 'changed');
    writeFileSync(signal, '');
  } catch {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    return undefined;
  }
  const signalFolder = folder;
  let touches = 0;
  const watchers = new Map<string, { readonly id: string; readonly watcher: FSWatcher }>();
  let timer: NodeJS.Timeout | undefined;
  let known = new Map<string, string | undefined>();

  const touch = (): void => {
    touches += 1;
    // A modification time that differs from every earlier one, whatever the clock's resolution.
    const at = new Date(Date.now() + touches * 1000);
    try {
      writeFileSync(signal, String(touches));
      utimesSync(signal, at, at);
    } catch {
      // The watch is closed.
    }
  };
  const check = (): void => {
    timer = undefined;
    const changed = [...known].filter(([link, was]) => destination(link) !== was);
    if (changed.length === 0) return;
    known = new Map([...known.keys()].map((link) => [link, destination(link)]));
    touch();
  };
  /** Reads the links again once the events that come together have come. */
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(check, SETTLE_MS);
  };
  const stopWatching = (): void => {
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
    clearTimeout(timer);
    timer = undefined;
  };
  const onExit = (): void => {
    rmSync(signalFolder, { recursive: true, force: true });
  };
  process.once('exit', onExit);

  return {
    signal,
    watch(links) {
      clearTimeout(timer);
      timer = undefined;
      known = new Map(links.map((link) => [link, destination(link)]));
      const parents = new Set(links.map((link) => dirname(link)));
      for (const [parent, { watcher }] of watchers) {
        if (parents.has(parent)) continue;
        watcher.close();
        watchers.delete(parent);
      }
      for (const parent of parents) {
        try {
          const stat = statSync(parent);
          const id = `${stat.dev}:${stat.ino}`;
          const held = watchers.get(parent);
          // Reopening healthy watches restarts macOS's shared stream after every build. Keep them,
          // but reopen a replaced parent and retry registrations that previously failed.
          if (held?.id === id) continue;
          held?.watcher.close();
          watchers.delete(parent);
          const watcher = watch(parent, schedule);
          watchers.set(parent, { id, watcher });
          // A folder that goes away, or a limit of the system: the links in it are read again.
          watcher.on('error', () => {
            if (watchers.get(parent)?.watcher !== watcher) return;
            watcher.close();
            watchers.delete(parent);
            schedule();
          });
        } catch {
          // The folder can't be watched; the links in it are read again with the next build.
          watchers.get(parent)?.watcher.close();
          watchers.delete(parent);
        }
      }
    },
    close() {
      stopWatching();
      process.removeListener('exit', onExit);
      onExit();
    },
  };
}
