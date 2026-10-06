/**
 * An in-memory file system for path-identity tests: folders, files and symbolic links on volumes
 * that each compare names with or without case, for POSIX or Windows path flavours. It answers
 * the queries of IdentityFileSystem the way the real one does.
 */
import type { PathFlavour } from '../../src/path-identity.js';
import type { IdentityFileSystem, IdentityStat } from '../../src/path-identity.js';

type FakeNode =
  | { readonly kind: 'dir'; readonly dev: bigint; readonly ino: bigint; readonly children: Map<string, FakeNode> }
  | { readonly kind: 'file'; readonly dev: bigint; readonly ino: bigint }
  | { readonly kind: 'link'; readonly dev: bigint; readonly ino: bigint; readonly target: string };

interface Volume {
  readonly dev: bigint;
  readonly insensitive: boolean;
}

const fold = (name: string): string => name.toLowerCase();

export class FakeIdentityFs implements IdentityFileSystem {
  private readonly roots = new Map<string, FakeNode & { kind: 'dir' }>();
  private readonly volumes = new Map<bigint, Volume>();
  private nextIno = 1n;
  /** Calls made, by query, so tests can check what is cached. */
  readonly calls = { realpath: 0, lstat: 0, readlink: 0, readdir: 0 };

  constructor(private readonly path: PathFlavour) {}

  /** Adds a volume mounted at `root` (a root such as `/` or `C:\`, or an existing folder's path). */
  mount(at: string, dev: number, insensitive: boolean): this {
    const volume: Volume = { dev: BigInt(dev), insensitive };
    this.volumes.set(volume.dev, volume);
    const dir = this.newDir(volume.dev);
    const { root, parts } = this.split(at);
    if (parts.length === 0) {
      this.roots.set(this.rootKey(root), dir);
      return this;
    }
    const parent = this.walk(this.path.join(root, ...parts.slice(0, -1)), true);
    if (parent?.kind !== 'dir') throw new Error(`no folder for mount ${at}`);
    parent.children.set(parts.at(-1) ?? '', dir);
    return this;
  }

  mkdir(path: string): this {
    this.add(path, (dev) => this.newDir(dev));
    return this;
  }

  file(path: string): this {
    this.add(path, (dev) => ({ kind: 'file', dev, ino: this.nextIno++ }));
    return this;
  }

  symlink(target: string, path: string): this {
    this.add(path, (dev) => ({ kind: 'link', dev, ino: this.nextIno++, target }));
    return this;
  }

  realpath(path: string): string {
    this.calls.realpath++;
    const { root, parts } = this.split(path);
    const resolved = this.resolveParts(this.rootKey(root), parts, 0);
    if (resolved === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return resolved;
  }

  lstat(path: string): IdentityStat | undefined {
    this.calls.lstat++;
    const node = this.walk(path, false);
    if (node === undefined) return undefined;
    return {
      dev: node.dev,
      ino: node.ino,
      isSymbolicLink: () => node.kind === 'link',
      isDirectory: () => node.kind === 'dir',
    };
  }

  readlink(path: string): string {
    this.calls.readlink++;
    const node = this.walk(path, false);
    if (node?.kind !== 'link') throw Object.assign(new Error(`EINVAL: ${path}`), { code: 'EINVAL' });
    return node.target;
  }

  readdir(dir: string, limit: number): readonly string[] {
    this.calls.readdir++;
    const node = this.walk(dir, true);
    return node?.kind === 'dir' ? [...node.children.keys()].slice(0, limit) : [];
  }

  private newDir(dev: bigint): FakeNode & { kind: 'dir' } {
    return { kind: 'dir', dev, ino: this.nextIno++, children: new Map() };
  }

  private rootKey(root: string): string {
    return root.toUpperCase().replace(/\//g, '\\');
  }

  private split(path: string): { root: string; parts: string[] } {
    const abs = this.path.resolve(path);
    const { root } = this.path.parse(abs);
    return { root, parts: abs.slice(root.length).split(this.path.sep).filter(Boolean) };
  }

  private add(path: string, make: (dev: bigint) => FakeNode): void {
    const { root, parts } = this.split(path);
    const name = parts.at(-1);
    if (name === undefined) throw new Error(`cannot add a root: ${path}`);
    const parent = this.walk(this.path.join(root, ...parts.slice(0, -1)), true);
    if (parent?.kind !== 'dir') throw new Error(`no folder for ${path}`);
    parent.children.set(name, make(parent.dev));
  }

  private child(dir: FakeNode & { kind: 'dir' }, name: string): [string, FakeNode] | undefined {
    const exact = dir.children.get(name);
    if (exact !== undefined) return [name, exact];
    if (this.volumes.get(dir.dev)?.insensitive !== true) return undefined;
    return [...dir.children].find(([stored]) => fold(stored) === fold(name));
  }

  /** The node at `path`, following links on the way, and at the end when `followLast`. */
  private walk(path: string, followLast: boolean): FakeNode | undefined {
    const { root, parts } = this.split(path);
    const real = followLast ? this.resolveParts(this.rootKey(root), parts, 0) : undefined;
    if (followLast) return real === undefined ? undefined : this.nodeAtReal(real);
    const parentReal = this.resolveParts(this.rootKey(root), parts.slice(0, -1), 0);
    if (parentReal === undefined) return undefined;
    const parent = this.nodeAtReal(parentReal);
    const name = parts.at(-1);
    if (name === undefined) return parent;
    return parent?.kind === 'dir' ? this.child(parent, name)?.[1] : undefined;
  }

  /** The node at a real path (stored names, no links). */
  private nodeAtReal(real: string): FakeNode | undefined {
    const { root, parts } = this.split(real);
    let node: FakeNode | undefined = this.roots.get(this.rootKey(root));
    for (const part of parts) node = node?.kind === 'dir' ? node.children.get(part) : undefined;
    return node;
  }

  /** The real path of `parts` below the root `rootKey`, or undefined when it doesn't exist. */
  private resolveParts(rootKey: string, parts: readonly string[], depth: number): string | undefined {
    const root = this.roots.get(rootKey);
    if (root === undefined || depth > 40) return undefined;
    let node: FakeNode = root;
    let real = this.path.parse(this.path.resolve(rootKey)).root;
    if (this.path.sep === '/') real = '/';
    for (const [i, part] of parts.entries()) {
      if (node.kind !== 'dir') return undefined;
      const found = this.child(node, part);
      if (found === undefined) return undefined;
      const [stored, next] = found;
      if (next.kind === 'link') {
        const target = this.path.resolve(real, next.target);
        const { root: targetRoot, parts: targetParts } = this.split(target);
        return this.resolveParts(this.rootKey(targetRoot), [...targetParts, ...parts.slice(i + 1)], depth + 1);
      }
      real = this.path.join(real, stored);
      node = next;
    }
    return real;
  }
}
