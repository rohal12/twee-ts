/**
 * The I/O safety matrix: whatever the output mode, the entry point, the input's role and the way the
 * output path is spelled, a build never writes over one of its inputs. A named overlap is a TweeTsError
 * (`OUTPUT_IS_INPUT`) and leaves every input byte as it was (#157 and its reopened sibling).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { compile, compileForOutputFile, compileToFile, watch, TweeTsError } from '../src/compiler.js';
import type { OutputMode } from '../src/types.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

const STORY = ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nPRECIOUS\n';
const MODES: readonly OutputMode[] = ['html', 'twee3', 'twee1', 'twine2-archive', 'twine1-archive', 'json'];

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'twee-ts-safety-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Whether the temporary folder's volume compares names without case. */
function caseInsensitiveTmp(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'twee-ts-case-'));
  try {
    writeFileSync(join(probe, 'Probe'), '');
    return existsSync(join(probe, 'PROBE'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = caseInsensitiveTmp();

type Role = 'source' | 'module' | 'head';

/** The input file of each role, and options that name it. */
function setup(role: Role): { readonly input: string; readonly options: Parameters<typeof compile>[0] } {
  const story = join(dir, 'story.tw');
  writeFileSync(story, STORY);
  const base = { formatId: 'test-format-1', formatPaths: [FORMAT_DIR], useTweegoPath: false, noRemote: true };
  switch (role) {
    case 'source':
      return { input: story, options: { ...base, sources: [story] } };
    case 'module': {
      const module = join(dir, 'mod.js');
      writeFileSync(module, 'window.PRECIOUS = 1;');
      return { input: module, options: { ...base, sources: [story], modules: [module] } };
    }
    case 'head': {
      const head = join(dir, 'head.html');
      writeFileSync(head, '<meta name="PRECIOUS">');
      return { input: head, options: { ...base, sources: [story], headFile: head } };
    }
    default: {
      const _exhaustive: never = role;
      throw new Error(`unhandled role ${String(_exhaustive)}`);
    }
  }
}

/** Ways of naming the output so that it is the input: each makes any links it needs and returns the path. */
const SPELLINGS: readonly {
  readonly name: string;
  readonly skip?: boolean;
  readonly make: (input: string) => string;
}[] = [
  { name: 'the same path', make: (input) => input },
  { name: 'with ./ and ..', make: (input) => join(dir, '.', 'x', '..', basename(input)) },
  { name: 'relative to the working directory', make: (input) => relative(process.cwd(), input) },
  {
    name: 'through a link to its folder',
    make: (input) => {
      symlinkSync(dir, join(dir, '..', `${basename(dir)}-alias`), 'junction');
      return join(dir, '..', `${basename(dir)}-alias`, basename(input));
    },
  },
  {
    name: 'through a link to the file',
    make: (input) => {
      symlinkSync(input, join(dir, 'link-to-input'));
      return join(dir, 'link-to-input');
    },
  },
  {
    name: 'as a hard link of it',
    make: (input) => {
      linkSync(input, join(dir, 'hard-link'));
      return join(dir, 'hard-link');
    },
  },
  {
    name: 'in another letter case (case-insensitive volume)',
    skip: !CASE_INSENSITIVE,
    make: (input) => join(dir, basename(input).toUpperCase()),
  },
];

afterEach(() => {
  rmSync(join(dir, '..', `${basename(dir)}-alias`), { force: true });
});

/** Every input byte, to compare after a refused build. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of ['story.tw', 'mod.js', 'head.html']) {
    const path = join(dir, name);
    if (existsSync(path)) files.set(name, readFileSync(path, 'utf-8'));
  }
  return files;
}

type Entry = 'compileToFile' | 'compileForOutputFile' | 'watch';
const ENTRIES: readonly Entry[] = ['compileToFile', 'compileForOutputFile', 'watch'];

async function run(entry: Entry, options: Parameters<typeof compile>[0], outFile: string): Promise<unknown> {
  switch (entry) {
    case 'compileToFile':
      return compileToFile({ ...options, outFile });
    case 'compileForOutputFile':
      return compileForOutputFile(options, outFile);
    case 'watch': {
      const controller = await watch({ ...options, outFile });
      controller.abort();
      return controller;
    }
    default: {
      const _exhaustive: never = entry;
      throw new Error(`unhandled entry ${String(_exhaustive)}`);
    }
  }
}

describe('an output that is a named input is refused in every mode, role, spelling and entry point', () => {
  for (const role of ['source', 'module', 'head'] as const) {
    for (const spelling of SPELLINGS) {
      describe.skipIf(spelling.skip === true)(`${role}, output named ${spelling.name}`, () => {
        for (const mode of MODES) {
          for (const entry of ENTRIES) {
            it(`${mode}, ${entry}`, async () => {
              const { input, options } = setup(role);
              const outFile = spelling.make(input);
              const before = snapshot();
              const build = run(entry, { ...options, outputMode: mode }, outFile);
              await expect(build).rejects.toThrow(TweeTsError);
              await expect(build).rejects.toMatchObject({
                code: 'OUTPUT_IS_INPUT',
                message: expect.stringContaining('Output file cannot be an input source'),
              });
              expect(snapshot()).toEqual(before);
            });
          }
        }
      });
    }
  }
});

describe('the config file and story formats are inputs too', () => {
  it('refuses an output that is the CLI config file (extra input)', async () => {
    const { options } = setup('source');
    const config = join(dir, 'twee-ts.config.json');
    writeFileSync(config, '{}');
    await expect(compileForOutputFile(options, config, undefined, [{ role: 'config', path: config }])).rejects.toThrow(
      `path ${config}: Output file cannot be an input source (the config).`,
    );
    expect(readFileSync(config, 'utf-8')).toBe('{}');
  });

  it('refuses an output that is the story format file in use', async () => {
    const formats = join(dir, 'formats');
    mkdirSync(join(formats, 'mine-1'), { recursive: true });
    const formatJs = join(formats, 'mine-1', 'format.js');
    const original = readFileSync(join(FORMAT_DIR, 'test-format-1', 'format.js'), 'utf-8');
    writeFileSync(formatJs, original);
    const { options } = setup('source');
    const build = compileToFile({ ...options, formatId: 'mine-1', formatPaths: [formats], outFile: formatJs });
    await expect(build).rejects.toThrow(/Output file cannot be an input source \(the story format\)/);
    expect(readFileSync(formatJs, 'utf-8')).toBe(original);
  });
});

describe('an output found while walking a source folder (FS-07)', () => {
  const twee = (mode: OutputMode): boolean => mode === 'twee3' || mode === 'twee1';

  it('refuses to overwrite an author file of a source type, which the walk would have loaded', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'data.tw'), STORY.replace(':: Start\nPRECIOUS\n', ''));
    writeFileSync(join(dir, 'src', 'chapter.tw'), ':: Start\nPRECIOUS CHAPTER\n');
    const outFile = join(dir, 'src', 'chapter.tw');
    const build = compileToFile({ sources: [join(dir, 'src')], outputMode: 'twee3', outFile });
    await expect(build).rejects.toThrow(/inside the source folder .*src, and not an earlier build/);
    await expect(build).rejects.toMatchObject({ code: 'OUTPUT_IS_INPUT' });
    expect(readFileSync(outFile, 'utf-8')).toBe(':: Start\nPRECIOUS CHAPTER\n');
  });

  it('writes over it when an exclude glob leaves it out of the sources', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), STORY);
    const outFile = join(dir, 'src', 'out.tw');
    writeFileSync(outFile, ':: Old\nx\n');
    const glob = `${relative(process.cwd(), dir).replace(/\\/g, '/')}/src/out.tw`;
    await compileToFile({ sources: [join(dir, 'src')], outputMode: 'twee3', outFile, exclude: [glob] });
    expect(readFileSync(outFile, 'utf-8')).toContain('PRECIOUS');
  });

  for (const mode of MODES.filter((m) => !twee(m) && m !== 'twine1-archive')) {
    it(`skips an earlier build it recognises (${mode}), as #88 and #118 do`, async () => {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.tw'), STORY);
      const ext = mode === 'json' ? 'json' : 'html';
      const outFile = join(dir, 'src', `z-out.${ext}`);
      const options = {
        sources: [join(dir, 'src')],
        outputMode: mode,
        outFile,
        formatId: 'test-format-1',
        formatPaths: [FORMAT_DIR],
        useTweegoPath: false,
      };
      await compileToFile(options);
      // Another process (no memory of the first build) builds again.
      const copy = readFileSync(outFile, 'utf-8');
      rmSync(outFile);
      writeFileSync(outFile, copy);
      writeFileSync(join(dir, 'src', 'a.tw'), STORY.replace('PRECIOUS', 'UPDATED'));
      const second = await compileToFile(options);
      expect(second.stats.files).toHaveLength(1);
      expect(readFileSync(outFile, 'utf-8')).toContain('UPDATED');
    });
  }

  it('skips an output of a type the walk would not load', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), STORY);
    const outFile = join(dir, 'src', 'story.txt');
    writeFileSync(outFile, 'notes');
    await compileToFile({ sources: [join(dir, 'src')], outputMode: 'twee3', outFile });
    expect(readFileSync(outFile, 'utf-8')).toContain('PRECIOUS');
  });

  it('lets a running watch write over its own earlier Twee build', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), STORY);
    const outFile = join(dir, 'src', 'all.tw');
    const first = await compileToFile({ sources: [join(dir, 'src')], outputMode: 'twee3', outFile });
    expect(first.diagnostics).toEqual([]);
    // The same process wrote it and nothing changed it since: an earlier build.
    const second = await compileToFile({ sources: [join(dir, 'src')], outputMode: 'twee3', outFile });
    expect(second.stats.files).toEqual([relative(process.cwd(), join(dir, 'src', 'a.tw'))]);
  });

  it('is not checked for a bundler, whose outputs are its own', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.tw'), STORY);
    writeFileSync(join(dir, 'src', 'chunk.js'), 'bundled');
    const result = await compileForOutputFile(
      { sources: [join(dir, 'src')], outputMode: 'twee3' },
      { files: [join(dir, 'src', 'chunk.js')], dirs: [] },
    );
    expect(result.stats.files).toHaveLength(1);
  });

  it('names the module folder for an author file found in it', async () => {
    writeFileSync(join(dir, 'a.tw'), STORY);
    mkdirSync(join(dir, 'mods'));
    writeFileSync(join(dir, 'mods', 'style.css'), 'body{}');
    const outFile = join(dir, 'mods', 'style.css');
    await expect(
      compileToFile({ sources: [join(dir, 'a.tw')], modules: [join(dir, 'mods')], outputMode: 'json', outFile }),
    ).rejects.toThrow(/module file inside the module folder/);
    expect(readFileSync(outFile, 'utf-8')).toBe('body{}');
  });
});

describe('a compile with no output is never refused', () => {
  it('compiles a source that some other build writes', async () => {
    const { options } = setup('source');
    const result = await compile({ ...options, outputMode: 'twee3' });
    expect(result.output).toContain('PRECIOUS');
    expect(dirname(join(dir, 'story.tw'))).toBe(dir);
  });
});
