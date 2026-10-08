/**
 * What a bundler's watch mode (`rollup --watch`, `vite build --watch`) is told
 * to watch for the story, whose inputs the plugins read outside the module
 * graph. Rollup's watcher and the Rolldown watcher of later Vite 8 releases
 * watch a registered folder recursively; earlier ones see only the folder's own
 * entries. So every path is registered on its own as well.
 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realPathOf, walkedEntry } from '../filesystem.js';
import type { OutputPaths } from '../filesystem.js';
import { toPosix } from './paths.js';

/**
 * How a target is spelt: as reached from the input (`given`, what Rollup's
 * watcher reports back), or by its real path (`real`, forward slashes), which
 * Vite's watchers report (macOS FSEvents reports a file under /var as under
 * /private/var, its real path).
 */
export type TargetSpelling = 'given' | 'real';

/** What walking one path found: the paths to register for it, and whether the path itself is among them. */
interface Walked {
  readonly targets: readonly string[];
  readonly whole: boolean;
}

const NOTHING: Walked = { targets: [], whole: false };

/**
 * The paths to register for the inputs (forward-slash paths): every file under
 * them that source discovery reads, but those `skip` returns true for, and no
 * path the build writes (`outputs`). With `real` spelling, a path that is a link, and each link above an input, is registered as authored too.
 *
 * A folder is registered, with what it holds, only when watching it reports
 * nothing the story leaves out: nothing below it is skipped (an `exclude`
 * match), is an output or holds one, or is a link to a folder (which source
 * discovery doesn't follow, and which may lead to the output). Of any other
 * folder only what it holds is registered, minus those, so writing the outputs
 * or editing an excluded file starts no build. A file added straight to such a folder is read at the next build
 * something else starts. An input that can't be read is registered as it is
 * (unless it is an output folder), so its creation may start a build; below an
 * input, what can't be read is left out, as source discovery leaves it out.
 */
export function watchTargets(
  inputs: readonly string[],
  skip: (file: string) => boolean,
  outputs: OutputPaths,
  spelling: TargetSpelling,
): string[] {
  // By real path, a path that is a link itself is also registered as authored: replacing the link changes what
  // the input is, and only its own location sees that.
  const spell = (path: string, real: string): string[] => {
    if (spelling === 'given') return [path];
    const realSpelling = toPosix(real);
    return toPosix(path) !== realSpelling && isLink(path) ? [realSpelling, toPosix(path)] : [realSpelling];
  };
  const walk = (path: string, real: string, isRoot: boolean): Walked => {
    if (outputs.isFile(real) || (!isRoot && outputs.isDir(real))) return NOTHING;
    let entry;
    let names;
    try {
      entry = isRoot ? { stat: statSync(path), real } : walkedEntry(path, real);
      if (entry === undefined || outputs.isFile(entry.real)) return NOTHING;
      if (!entry.stat.isDirectory()) return skip(path) ? NOTHING : { targets: spell(path, entry.real), whole: true };
      names = readdirSync(path);
    } catch {
      return isRoot && !outputs.isDir(real) ? { targets: spell(path, real), whole: true } : NOTHING;
    }
    const folder = entry.real;
    const children = names.map((name) => walk(`${path}/${name}`, join(folder, name), false));
    const held = children.flatMap((child) => child.targets);
    const whole = !outputs.holds(folder) && children.every((child) => child.whole);
    return whole ? { targets: [...spell(path, folder), ...held], whole } : { targets: held, whole };
  };
  return inputs.flatMap((input) => [
    ...(spelling === 'real' ? linkedAncestors(input, outputs) : []),
    ...walk(input, realPathOf(input), true).targets,
  ]);
}

/**
 * The paths to register, besides the real paths of the files a bundle read, so that the build watch sees what
 * changes how the entry's imports resolve: each spelling (absolute) of an import that reaches a file through a
 * link, as authored, with the links above it (replacing one changes the file the import reads); and for a spelling
 * that reaches nothing, the nearest folder that exists, where creating the file shows (a bundle that failed for a
 * missing import). A folder that holds a build output is left out, since the watcher would report what the build
 * writes there and rebuild for ever: a file created straight in it is read with the next build something else starts.
 */
export function importWatchTargets(authored: Iterable<string>, outputs: OutputPaths): string[] {
  const targets = new Set<string>();
  for (const spelling of authored) {
    if (existsSync(spelling)) {
      if (toPosix(realPathOf(spelling)) === toPosix(spelling)) continue;
      for (const link of linkedAncestors(spelling, outputs)) targets.add(link);
      if (isLink(spelling)) targets.add(toPosix(spelling));
      continue;
    }
    let folder = dirname(spelling);
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (existsSync(folder) && !outputs.holds(realPathOf(folder))) targets.add(toPosix(folder));
  }
  return [...targets];
}

/**
 * The links among the folders above `path`, as authored (forward slashes), nearest last. Replacing one of them
 * changes what the input is, and only its own location sees that. A link directly in the root of the file system
 * (`/var` on macOS) is the system's own alias and is left out, as is a link to a folder that holds a build output,
 * since watching it whole would rebuild for what the build writes.
 */
function linkedAncestors(path: string, outputs: OutputPaths): string[] {
  const links: string[] = [];
  for (let folder = dirname(path); dirname(dirname(folder)) !== dirname(folder); folder = dirname(folder)) {
    if (isLink(folder) && !outputs.holds(realPathOf(folder))) links.unshift(toPosix(folder));
  }
  return links;
}

/** Whether `path` is a symbolic link (or a Windows junction); a path that can't be read is none. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
