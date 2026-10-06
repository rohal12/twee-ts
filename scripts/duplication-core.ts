/**
 * Pure logic of the duplication check (scripts/duplication.ts): reading the
 * three tools' reports and the settings files, comparing a measurement with
 * its budget and base, and rendering the summary. Running the tools and git is
 * left to scripts/duplication.ts.
 */
import { isAbsolute, relative, resolve } from 'node:path';

export const TOOLS = ['jscpd', 'cpd', 'fallow'] as const;
export type Tool = (typeof TOOLS)[number];

export function isTool(value: string): value is Tool {
  return TOOLS.some((tool) => tool === value);
}

/** A run of lines in one file, 1-based and inclusive. */
export interface Location {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

export interface Clone {
  /** Identifies the clone across trees: its files and instance sizes. */
  readonly key: string;
  /** Lines of all instances together. */
  readonly lines: number;
  /** `file:start-end` for each instance, paths relative to the tree. */
  readonly locations: readonly string[];
}

export interface Measurement {
  readonly percentage: number;
  readonly duplicatedLines: number;
  readonly totalLines: number;
  readonly clones: readonly Clone[];
}

export interface Budget {
  /** Highest duplication percentage allowed, per tool. */
  readonly maxPercentage: Readonly<Record<Tool, number>>;
}

/** The part of .jscpd.json that CPD shares with jscpd. */
export interface ScanSettings {
  /** Directories to scan, relative to the tree. */
  readonly paths: readonly string[];
  readonly minTokens: number;
}

export interface BaseMeasurement {
  readonly ref: string;
  readonly measurement: Measurement;
}

export interface Arguments {
  readonly tools: readonly Tool[];
  readonly base: string | undefined;
}

export const USAGE = `usage: tsx scripts/duplication.ts [${TOOLS.join('|')}]... [--base <ref>]`;

// ---------------------------------------------------------------------------
// Reading untrusted JSON

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, where: string): JsonObject {
  if (!isObject(value)) throw new Error(`${where} is not an object`);
  return value;
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not an array`);
  return value;
}

function finiteNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} is not a finite number`);
  return value;
}

function lineNumber(value: unknown, where: string): number {
  const n = finiteNumber(value, where);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${where} is not a line number: ${n}`);
  return n;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} is not a non-empty string`);
  return value;
}

/** Own property only, so a key such as `__proto__` or `constructor` reads as absent. */
function field(obj: JsonObject, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// ---------------------------------------------------------------------------
// Settings

export function parseBudget(json: unknown, where = 'duplication-budget.json'): Budget {
  const max = object(field(object(json, where), 'maxPercentage'), `${where}: maxPercentage`);
  const unknown = Object.keys(max).filter((key) => !isTool(key));
  if (unknown.length > 0) throw new Error(`${where}: maxPercentage has unknown tools: ${unknown.join(', ')}`);
  const read = (tool: Tool): number => {
    const value = finiteNumber(field(max, tool), `${where}: maxPercentage.${tool}`);
    if (value < 0 || value > 100) throw new Error(`${where}: maxPercentage.${tool} is outside 0–100: ${value}`);
    return value;
  };
  return { maxPercentage: { jscpd: read('jscpd'), cpd: read('cpd'), fallow: read('fallow') } };
}

export function parseScanSettings(json: unknown, where = '.jscpd.json'): ScanSettings {
  const config = object(json, where);
  const paths = array(field(config, 'path'), `${where}: path`).map((p, i) => {
    const path = nonEmptyString(p, `${where}: path[${i}]`);
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw new Error(`${where}: path[${i}] must stay inside the repository: ${path}`);
    }
    return path;
  });
  if (paths.length === 0) throw new Error(`${where}: path is empty`);
  const minTokens = finiteNumber(field(config, 'minTokens'), `${where}: minTokens`);
  if (!Number.isInteger(minTokens) || minTokens < 1) {
    throw new Error(`${where}: minTokens is not a positive integer: ${minTokens}`);
  }
  return { paths, minTokens };
}

export function parseArguments(args: readonly string[]): Arguments {
  const tools: Tool[] = [];
  let base: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--base') {
      const ref = args[i + 1];
      if (ref === undefined || ref === '' || ref.startsWith('-')) throw new Error(`--base needs a git ref\n${USAGE}`);
      if (base !== undefined) throw new Error(`--base given twice\n${USAGE}`);
      base = ref;
      i++;
    } else if (isTool(arg)) {
      if (!tools.includes(arg)) tools.push(arg);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  return { tools: tools.length > 0 ? tools : [...TOOLS], base };
}

// ---------------------------------------------------------------------------
// Clones and reports

/** A clone made of `instances`, with paths made relative to `tree`. */
export function makeClone(tree: string, instances: readonly Location[]): Clone {
  const located = instances.map((l) => ({
    ...l,
    file: relative(tree, resolve(tree, l.file)).split('\\').join('/'),
  }));
  return {
    // Line numbers shift with any edit above a clone; files and sizes don't
    key: located
      .map((l) => `${l.file}#${l.end - l.start}`)
      .sort()
      .join('|'),
    lines: located.reduce((sum, l) => sum + l.end - l.start + 1, 0),
    locations: located.map((l) => `${l.file}:${l.start}-${l.end}`),
  };
}

function location(file: string, start: number, end: number, where: string): Location {
  if (end < start) throw new Error(`${where} ends (line ${end}) before it starts (line ${start})`);
  return { file, start, end };
}

/** jscpd's `--reporters json` output (jscpd-report.json). */
export function parseJscpdReport(json: unknown, tree: string): Measurement {
  const where = 'jscpd report';
  const report = object(json, where);
  const total = object(
    field(object(field(report, 'statistics'), `${where}: statistics`), 'total'),
    `${where}: statistics.total`,
  );
  const duplicates = array(field(report, 'duplicates'), `${where}: duplicates`);
  return {
    percentage: finiteNumber(field(total, 'percentage'), `${where}: statistics.total.percentage`),
    duplicatedLines: finiteNumber(field(total, 'duplicatedLines'), `${where}: statistics.total.duplicatedLines`),
    totalLines: finiteNumber(field(total, 'lines'), `${where}: statistics.total.lines`),
    clones: duplicates.map((d, i) => {
      const duplicate = object(d, `${where}: duplicates[${i}]`);
      const instances = (['firstFile', 'secondFile'] as const).map((side) => {
        const at = `${where}: duplicates[${i}].${side}`;
        const file = object(field(duplicate, side), at);
        return location(
          nonEmptyString(field(file, 'name'), `${at}.name`),
          lineNumber(field(file, 'start'), `${at}.start`),
          lineNumber(field(file, 'end'), `${at}.end`),
          at,
        );
      });
      return makeClone(tree, instances);
    }),
  };
}

/** fallow's `dupes --format json` output. */
export function parseFallowReport(json: unknown, tree: string): Measurement {
  const where = 'fallow report';
  const report = object(json, where);
  const stats = object(field(report, 'stats'), `${where}: stats`);
  const groups = array(field(report, 'clone_groups'), `${where}: clone_groups`);
  return {
    percentage: finiteNumber(field(stats, 'duplication_percentage'), `${where}: stats.duplication_percentage`),
    duplicatedLines: finiteNumber(field(stats, 'duplicated_lines'), `${where}: stats.duplicated_lines`),
    totalLines: finiteNumber(field(stats, 'total_lines'), `${where}: stats.total_lines`),
    clones: groups.map((g, i) => {
      const at = `${where}: clone_groups[${i}]`;
      const instances = array(field(object(g, at), 'instances'), `${at}.instances`).map((inst, j) => {
        const instance = object(inst, `${at}.instances[${j}]`);
        return location(
          nonEmptyString(field(instance, 'file'), `${at}.instances[${j}].file`),
          lineNumber(field(instance, 'start_line'), `${at}.instances[${j}].start_line`),
          lineNumber(field(instance, 'end_line'), `${at}.instances[${j}].end_line`),
          `${at}.instances[${j}]`,
        );
      });
      if (instances.length < 2) throw new Error(`${at} has fewer than two instances`);
      return makeClone(tree, instances);
    }),
  };
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string, where: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (entity, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    const decoded = Object.hasOwn(XML_ENTITIES, name) ? XML_ENTITIES[name] : undefined;
    if (decoded === undefined) throw new Error(`${where}: unknown XML entity ${entity}`);
    return decoded;
  });
}

function xmlAttributes(tag: string, where: string): ReadonlyMap<string, string> {
  return new Map([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1] ?? '', decodeXml(m[2] ?? '', where)]));
}

function attribute(attributes: ReadonlyMap<string, string>, name: string, where: string): string {
  const value = attributes.get(name);
  if (value === undefined) throw new Error(`${where} has no ${name} attribute`);
  return value;
}

export interface CpdReport {
  /** Every file CPD tokenized, as it names them. */
  readonly analyzedFiles: readonly string[];
  readonly clones: readonly Clone[];
  /** Distinct lines inside any clone instance. */
  readonly duplicatedLines: number;
}

/**
 * PMD CPD's `--format xml` output. CPD reports no totals, so the duplicated
 * lines are counted here: each line once, however many clones cover it.
 */
export function parseCpdReport(xml: string, tree: string): CpdReport {
  const where = 'CPD report';
  if (!/<pmd-cpd[\s>]/.test(xml)) throw new Error(`${where} has no <pmd-cpd> element`);
  // Code fragments may contain anything that looks like markup
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const errors = [...markup.matchAll(/<error\b([^>]*)>/g)].map((m) => {
    const attributes = xmlAttributes(m[1] ?? '', where);
    return `${attributes.get('filename') ?? '?'}: ${attributes.get('msg') ?? 'error'}`;
  });
  if (errors.length > 0) throw new Error(`${where} lists processing errors:\n${errors.join('\n')}`);

  const duplications = [...markup.matchAll(/<duplication\b[^>]*>([\s\S]*?)<\/duplication>/g)];
  // Top-level <file> elements list the analyzed files; those inside a
  // <duplication> are clone instances
  const outside = markup.replace(/<duplication\b[^>]*>[\s\S]*?<\/duplication>/g, '');
  const analyzedFiles = [...outside.matchAll(/<file\b([^>]*?)\/?>/g)].map((m) =>
    attribute(xmlAttributes(m[1] ?? '', where), 'path', `${where}: <file>`),
  );

  const covered = new Map<string, Set<number>>();
  const clones = duplications.map((d, i) => {
    const at = `${where}: duplication ${i + 1}`;
    const instances = [...(d[1] ?? '').matchAll(/<file\b([^>]*?)\/?>/g)].map((m) => {
      const attributes = xmlAttributes(m[1] ?? '', at);
      return location(
        attribute(attributes, 'path', at),
        lineNumber(Number(attribute(attributes, 'line', at)), `${at}: line`),
        lineNumber(Number(attribute(attributes, 'endline', at)), `${at}: endline`),
        at,
      );
    });
    if (instances.length < 2) throw new Error(`${at} has fewer than two instances`);
    const clone = makeClone(tree, instances);
    for (const { file, start, end } of instances) {
      const key = resolve(tree, file);
      const lines = covered.get(key) ?? new Set<number>();
      for (let line = start; line <= end; line++) lines.add(line);
      covered.set(key, lines);
    }
    return clone;
  });
  const duplicatedLines = [...covered.values()].reduce((sum, lines) => sum + lines.size, 0);
  return { analyzedFiles, clones, duplicatedLines };
}

export interface Sources {
  /** TypeScript files, which all three tools read. */
  readonly typescript: readonly string[];
  /** Other JavaScript or TypeScript files, which PMD's TypeScript language would skip. */
  readonly unsupported: readonly string[];
}

/**
 * Sorts the scanned files. CPD picks TypeScript files by the `.ts` extension
 * alone, so any other script file would be measured by jscpd and fallow but
 * not by CPD; the check refuses such a tree rather than measure it unevenly.
 */
export function classifySources(files: readonly string[]): Sources {
  return {
    typescript: files.filter((f) => f.endsWith('.ts')),
    unsupported: files.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f) && !f.endsWith('.ts')),
  };
}

/** Lines of a source file; a final newline ends the last line rather than starting another. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

export function percentage(part: number, whole: number): number {
  return whole === 0 ? 0 : (100 * part) / whole;
}

// ---------------------------------------------------------------------------
// Verdict and summary

const pct = (n: number): string => `${n.toFixed(2)}%`;
const signed = (n: number, format: (n: number) => string): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : '±'}${format(Math.abs(n))}`;

/** Why the measurement fails; empty when it passes. */
export function failures(max: number, head: Measurement, base: BaseMeasurement | undefined): readonly string[] {
  const found: string[] = [];
  if (head.percentage > max) {
    found.push(`duplication ${pct(head.percentage)} exceeds the budget of ${pct(max)}`);
  }
  // New duplication means more duplicated lines and a larger share of the
  // code: a change that adds much code and a little duplication can lower the
  // share, and one that edits inside a clone can change its size.
  if (base) {
    const b = base.measurement;
    if (head.duplicatedLines > b.duplicatedLines && head.percentage > b.percentage) {
      found.push(
        `duplication grew from ${pct(b.percentage)} to ${pct(head.percentage)} ` +
          `(${b.duplicatedLines} → ${head.duplicatedLines} duplicated lines) compared with ${base.ref}`,
      );
    }
  }
  return found;
}

/** Clones of `head` that `base` doesn't have. */
export function newClones(head: Measurement, base: Measurement): readonly Clone[] {
  const known = new Set(base.clones.map((c) => c.key));
  return head.clones.filter((c) => !known.has(c.key));
}

export function largestClones(m: Measurement): readonly Clone[] {
  return [...m.clones].sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key));
}

const LISTED = 15;

/** Markdown for the job summary and the console. */
export function renderSummary(
  tool: Tool,
  max: number,
  head: Measurement,
  base: BaseMeasurement | undefined,
  failed: readonly string[],
): string {
  const lines = [`## Duplication: ${tool}`, '', '| | Duplication | Duplicated lines | Clones |', '|---|---|---|---|'];
  const row = (label: string, m: Measurement): string =>
    `| ${label} | ${pct(m.percentage)} | ${m.duplicatedLines} / ${m.totalLines} | ${m.clones.length} |`;
  if (base) {
    // A commit hash from CI reads better short
    const label = /^[0-9a-f]{40}$/.test(base.ref) ? base.ref.slice(0, 7) : base.ref;
    const b = base.measurement;
    lines.push(
      row(`base ${label}`, b),
      row('this tree', head),
      `| change | ${signed(head.percentage - b.percentage, pct)} | ` +
        `${signed(head.duplicatedLines - b.duplicatedLines, String)} | ` +
        `${signed(head.clones.length - b.clones.length, String)} |`,
    );
  } else {
    lines.push(row('this tree', head));
  }
  lines.push('', `Budget: ${pct(max)} (duplication-budget.json).`, '');

  const list = (title: string, clones: readonly Clone[]): void => {
    if (clones.length === 0) return;
    lines.push(`### ${title}`, '');
    for (const c of clones.slice(0, LISTED)) {
      lines.push(`- ${c.lines} lines: ${c.locations.map((l) => `\`${l}\``).join(', ')}`);
    }
    if (clones.length > LISTED) lines.push(`- … and ${clones.length - LISTED} more`);
    lines.push('');
  };
  if (base) list('New clones', newClones(head, base.measurement));
  list('Largest clones', largestClones(head));
  if (failed.length > 0) lines.push('### Failed', '', ...failed.map((f) => `- ${f}`), '');
  return lines.join('\n');
}
