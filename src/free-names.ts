/**
 * First-free names for an occupancy set that only grows. Each base remembers the suffixes already found
 * occupied; overlapping bases still check the shared occupancy predicate. Recreate this allocator whenever
 * names are freed, so the first available suffix can be reused.
 */
export class FreeNames {
  readonly #next = new Map<string, number>();

  constructor(
    private readonly isFree: (name: string) => boolean,
    private readonly separator = ' ',
  ) {}

  take(base: string): string {
    if (this.isFree(base)) return base;
    for (let n = this.#next.get(base) ?? 2; ; n++) {
      const candidate = `${base}${this.separator}${String(n)}`;
      if (this.isFree(candidate)) {
        this.#next.set(base, n + 1);
        return candidate;
      }
    }
  }
}
