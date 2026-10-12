/**
 * What a bundler's watch mode (`rollup --watch`, `vite build --watch`) is told
 * to watch for the story, whose inputs the plugins read outside the module
 * graph. Rollup's watcher and the Rolldown watcher of later Vite 8 releases
 * watch a registered folder recursively; earlier ones see only the folder's own
 * entries. So every path is registered on its own as well.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
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

/** What the build watch is to watch for the inputs: the paths to register, and the links the inputs are reached through. */
export interface WatchPlan {
  /** The paths to register with the bundler's watcher (forward slashes). */
  readonly targets: string[];
  /**
   * Every link the inputs are reached through, as authored (platform paths): each hop of a chain of links, the links
   * among the folders above an input and the links below a source folder that source discovery follows. A watcher
   * that follows links watches the end of a chain, and does not report that a link was pointed elsewhere.
   */
  readonly links: string[];
  /**
   * With `given` spelling, the real path of each target (platform paths). A watcher that follows links keeps watching
   * what a target led to when it was registered, also after a link on the way leads elsewhere, so a target whose real
   * path changed is registered by its new real path as well.
   */
  readonly reals: ReadonlyMap<string, string>;
}

/**
 * The paths to register for the inputs (forward-slash paths): every file under
 * them that source discovery reads, but those `skip` returns true for, and no
 * path the build writes (`outputs`). With `real` spelling, each link an input is reached through is registered as
 * authored too, every hop of a chain of links (see linksOnTheWay), but those that lead to a folder holding an output.
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
  return watchPlan(inputs, skip, outputs, spelling).targets;
}

/** What watchTargets registers for the inputs, and the links they are reached through. */
export function watchPlan(
  inputs: readonly string[],
  skip: (file: string) => boolean,
  outputs: OutputPaths,
  spelling: TargetSpelling,
): WatchPlan {
  const links = new Set<string>();
  /** Every link on the way to `path`, noted; those registered by real path are the ones that lead to no output. */
  const hopsOf = (path: string): string[] => {
    const hops = linksOnTheWay(path);
    for (const hop of hops) links.add(hop);
    return hops.filter((hop) => !outputs.holds(realPathOf(hop))).map(toPosix);
  };
  // By real path, each link a path is reached through is also registered as authored, every hop of a chain: replacing
  // a link changes what the input is, and only its own location sees that. A path below a folder is reached through
  // the links of the input above it, so only the links it is itself are looked for.
  // As given, a path is registered once: Rollup's watcher follows a link, watches what it leads to when the path is
  // first registered, and reports a change by the name it was given. The real path of each is noted, since a path that
  // leads elsewhere later is watched from there again (see WatchPlan.reals).
  const reals = new Map<string, string>();
  const spell = (path: string, real: string, isRoot: boolean): string[] => {
    if (spelling === 'real') return [toPosix(real), ...(isRoot || isLink(path) ? hopsOf(path) : [])];
    // A link found while walking a folder, to a file the build reads, is among the links the inputs are reached
    // through, each hop of its chain: pointing one elsewhere changes the story (#443). Links source discovery leaves
    // out (to a folder, to a file the build writes, to nothing) never get here, and are not watched (#160).
    if (!isRoot && isLink(path)) for (const hop of linksOnTheWay(path)) links.add(hop);
    // Rollup's watcher fails with an error nobody handles for a path that is a loop of links.
    if (isLoop(path)) return [];
    if (!isLoop(real)) reals.set(path, real);
    return [path];
  };
  const walk = (path: string, real: string, isRoot: boolean): Walked => {
    if (outputs.isFile(real) || (!isRoot && outputs.isDir(real))) return NOTHING;
    let entry;
    let names;
    try {
      entry = isRoot ? { stat: statSync(path), real } : walkedEntry(path, real);
      if (entry === undefined || outputs.isFile(entry.real)) return NOTHING;
      if (!entry.stat.isDirectory()) {
        return skip(path) ? NOTHING : { targets: spell(path, entry.real, isRoot), whole: true };
      }
      names = readdirSync(path);
    } catch {
      return isRoot && !outputs.isDir(real) ? { targets: spell(path, real, isRoot), whole: true } : NOTHING;
    }
    const folder = entry.real;
    const children = names.map((name) => walk(`${path}/${name}`, join(folder, name), false));
    const held = children.flatMap((child) => child.targets);
    const whole = !outputs.holds(folder) && children.every((child) => child.whole);
    return whole ? { targets: [...spell(path, folder, isRoot), ...held], whole } : { targets: held, whole };
  };
  const targets = inputs.flatMap((input) => {
    for (const link of linksOnTheWay(input)) links.add(link);
    return [
      ...(spelling === 'real' ? ancestorLinks(input, outputs) : []),
      ...walk(input, realPathOf(input), true).targets,
    ];
  });
  return { targets: [...new Set(targets)], links: [...links], reals };
}

/**
 * The paths to register, besides the real paths of the files a bundle read, so that the build watch sees what
 * changes how the entry's imports resolve: for each spelling (absolute) of an import that reaches a file through
 * links, every link on the way (see linksOnTheWay), the links a link leads through too (replacing any of them changes
 * the file the import reads); and for a spelling
 * that reaches nothing, the nearest folder that exists, where creating the file shows (a bundle that failed for a
 * missing import). A folder that holds a build output is left out, since the watcher would report what the build
 * writes there and rebuild for ever: a file created straight in it is read with the next build something else starts.
 */
export function importWatchTargets(authored: Iterable<string>, outputs: OutputPaths): string[] {
  const targets = new Set<string>();
  const missing: string[] = [];
  for (const spelling of authored) {
    if (existsSync(spelling)) {
      if (toPosix(realPathOf(spelling)) === toPosix(spelling)) continue;
      for (const link of linksOnTheWay(spelling)) if (!outputs.holds(realPathOf(link))) targets.add(toPosix(link));
      continue;
    }
    missing.push(spelling);
  }
  for (const folder of missingImportFolders(missing)) {
    if (!outputs.holds(realPathOf(folder))) targets.add(toPosix(folder));
  }
  return [...targets];
}

/**
 * The nearest folder that exists, for each of the paths in `authored` that reaches nothing: where creating that
 * file (or the folders above it) shows. Of a path that exists there is none, and neither is the root of a file
 * system (an absolute import such as `/missing.js`, which Vite reads from the project root first), which no watcher
 * is asked to watch whole.
 */
export function missingImportFolders(authored: Iterable<string>): string[] {
  const folders = new Set<string>();
  for (const spelling of authored) {
    if (existsSync(spelling)) continue;
    let folder = dirname(spelling);
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (existsSync(folder) && dirname(folder) !== folder) folders.add(folder);
  }
  return [...folders];
}

/**
 * The links among the folders above `path`, as authored (forward slashes), every hop of a chain, in the order they are
 * followed. Replacing one of them changes what the input is, and only its own location sees that. A link directly in
 * the root of the file system (`/var` on macOS) is the system's own alias and is left out, as is a link to a folder that
 * holds a build output, since watching it whole would rebuild for what the build writes.
 */
function ancestorLinks(path: string, outputs: OutputPaths): string[] {
  return linksOnTheWay(dirname(path))
    .filter((link) => !outputs.holds(realPathOf(link)))
    .map(toPosix);
}

/** How many links the file system follows for one path before it gives up (ELOOP on Linux). */
const MAX_LINK_HOPS = 40;

/**
 * Every link the file system follows to reach `path`, in the order it follows them: each link along the path, and
 * along the target each one leads to, so every hop of a link to a link (a chain) is there. A link directly in the
 * root of the file system (`/var` on macOS) is the system's own alias and is left out. The walk ends where a name
 * reaches nothing, or after as many hops as the file system follows.
 */
export function linksOnTheWay(path: string): string[] {
  const links: string[] = [];
  /** The names of a path or a link's target below its root; `..` is kept for the walk to take. */
  const names = (text: string, root: string): string[] =>
    text
      .slice(root.length)
      .split(/[/\\]/)
      .filter((name) => name !== '' && name !== '.');
  const start = resolve(path);
  let reached = parse(start).root;
  let rest = names(start, reached);
  for (let hops = 0; rest.length > 0 && hops <= MAX_LINK_HOPS;) {
    const [name = '', ...more] = rest;
    rest = more;
    if (name === '..') {
      // Up from where the links before it led, as the file system takes it.
      reached = dirname(reached);
      continue;
    }
    const next = join(reached, name);
    let target: string | undefined;
    try {
      target = lstatSync(next).isSymbolicLink() ? readlinkSync(next) : undefined;
    } catch {
      break; // Reaches nothing.
    }
    if (target === undefined) {
      reached = next;
      continue;
    }
    hops += 1;
    if (dirname(next) !== dirname(dirname(next))) links.push(next);
    // A relative target goes on from the folder that holds the link; an absolute one from its root.
    const root = isAbsolute(target) ? parse(target).root : '';
    if (root !== '') reached = root;
    rest = [...names(target, root), ...rest];
  }
  return links;
}

/** Whether `path` is a loop of links, which the file system gives up following (ELOOP). */
function isLoop(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'ELOOP';
  }
}

/** Whether `path` is a symbolic link (or a Windows junction); a path that can't be read is none. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
