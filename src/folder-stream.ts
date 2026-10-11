/**
 * The FSEvents stream behind every folder watch of a process on macOS (#436).
 *
 * libuv watches each folder on macOS through FSEvents, and runs all folder watches of a process on one stream:
 * starting or closing any folder watch replaces that stream (uv__fsevents_reschedule destroys it, with the events
 * it has not delivered yet, and creates a new one that reports changes from "now"). A change made while the stream
 * is being replaced is reported to no watch, including the watches that ran all along. A watch that starts watching
 * a new link's target, say, makes the edits that follow it go unseen.
 *
 * What was missed can't be known, but when the new stream runs can: a probe writes a file in a folder of its own,
 * watched like any other, until the stream reports it. Every change after that is reported again, and a full build
 * then reads every change made before it. Each watch that subscribes is told when the stream runs again.
 */
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How often the probe writes its file while it waits for the stream to report it. */
const PROBE_INTERVAL_MS = 25;
/** How many times it writes before it gives up (10 s): a stream that never reports it is no worse off than before. */
const PROBE_ATTEMPTS = 400;

interface Probe {
  readonly dir: string;
  readonly watcher: FSWatcher;
}

const listeners = new Set<() => void>();
/** The probe while anything subscribes; undefined when it could not be set up, or nothing subscribes. */
let probe: Probe | undefined;
/** Counts the replacements: the probe waits for its file of the latest one, never an earlier stream's event. */
let generation = 0;
/** Whether the stream was replaced and has not reported the probe since. */
let pending = false;
let attempts = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The file the probe wrote last, removed when it writes another. */
let written: string | undefined;

const probeName = (gen: number): string => `probe-${String(gen)}`;

function settle(): void {
  pending = false;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  for (const listener of [...listeners]) listener();
}

function openProbe(parent: string): Probe | undefined {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(parent, 'twee-ts-watch-probe-'));
    const watcher = watch(dir, {}, (_event, filename) => {
      if (pending && filename === probeName(generation)) settle();
    });
    watcher.on('error', () => {
      // The probe stops answering; replacements go unanswered, as they did before the probe.
      watcher.close();
    });
    return { dir, watcher };
  } catch {
    // No folder to probe in, or no watch on it: replacements go unanswered, as they did before the probe.
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

function closeProbe(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  pending = false;
  written = undefined;
  if (probe === undefined) return;
  probe.watcher.close();
  rmSync(probe.dir, { recursive: true, force: true });
  probe = undefined;
}

/** Writes the probe's file for the latest replacement, again every PROBE_INTERVAL_MS until it is reported. */
function attempt(dir: string): void {
  timer = undefined;
  if (!pending || attempts >= PROBE_ATTEMPTS) return;
  attempts++;
  const name = probeName(generation);
  try {
    if (written !== undefined && written !== name) rmSync(join(dir, written), { force: true });
    writeFileSync(join(dir, name), '');
    written = name;
  } catch {
    // The folder went (a cleaner of the temporary folder, say): the next attempt tries again.
  }
  timer = setTimeout(() => {
    attempt(dir);
  }, PROBE_INTERVAL_MS);
}

/**
 * Calls `listener` each time the stream has been replaced and runs again, for as long as the returned function is
 * not called. The probe's folder is made in `parent` (the system's temporary folder by default) when the first
 * listener subscribes, and removed when the last one leaves.
 */
export function onStreamRunning(listener: () => void, parent: string = tmpdir()): () => void {
  if (listeners.size === 0) probe = openProbe(parent);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) closeProbe();
  };
}

/** Folder watches were started or closed: the stream is replaced, and the probe waits for the new one. */
export function streamReplaced(): void {
  if (probe === undefined) return;
  generation++;
  pending = true;
  attempts = 0;
  if (timer === undefined) attempt(probe.dir);
}
