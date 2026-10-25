/** Inventory public copies by their destination names, following directory links as Vite's copyDir does. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileKey } from './paths.js';

export function publicFiles(publicDir: string): string[] {
  if (!existsSync(publicDir)) return [];
  const files: string[] = [];
  const ancestors = new Set<string>();
  const walk = (folder: string): void => {
    const key = fileKey(folder);
    // Vite cannot copy a cycle, but dev also reads this inventory and must terminate. Track only ancestors:
    // separate aliases of the same folder produce separate copies, each of which discovery must exclude.
    if (ancestors.has(key)) return;
    ancestors.add(key);
    for (const name of readdirSync(folder)) {
      const path = resolve(folder, name);
      // Dangling and looping links have no copy to exclude. They must not prevent dev from serving the story.
      if (!existsSync(path)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(publicDir, path));
    }
    ancestors.delete(key);
  };
  walk(publicDir);
  return files;
}
