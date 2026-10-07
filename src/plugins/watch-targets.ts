/**
 * What a bundler's watch mode (`rollup --watch`, `vite build --watch`) is told
 * to watch for the story, whose inputs the plugins read outside the module
 * graph. Rollup's watcher and the Rolldown watcher of later Vite 8 releases
 * watch a registered folder recursively; earlier ones see only the folder's own
 * entries. So every path is registered on its own as well.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
 * path the build writes (`outputs`). With `real` spelling, a path reached through a link is registered as authored too.
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
  // By real path, a path reached through a link is also registered as authored: replacing the link, or a link
  // above it, changes what the input is, and only the authored location sees that.
  const spell = (path: string, real: string): string[] => {
    if (spelling === 'given') return [path];
    const realSpelling = toPosix(real);
    return toPosix(path) === realSpelling ? [realSpelling] : [realSpelling, toPosix(path)];
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
  return inputs.flatMap((input) => walk(input, realPathOf(input), true).targets);
}
