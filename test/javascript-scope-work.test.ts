import { describe, expect, it } from 'vitest';
import { Parser } from 'acorn';
import { compile, parseFormatJSON, storyInspect } from '../src/index.js';
import { AcornParser, SCRIPT_OPTIONS, parseScript } from '../src/js-syntax.js';
import { STORY } from './helpers/plugins.js';

/** Count the elements searched by native array membership checks, including Acorn's binding lists. */
async function bindingWork<T>(run: () => T | Promise<T>): Promise<{ value: T; work: number }> {
  let work = 0;
  const original = Array.prototype.indexOf;
  Array.prototype.indexOf = function <T>(this: T[], value: T, from?: number): number {
    work += this.length;
    return original.call(this, value, from);
  };
  try {
    return { value: await run(), work };
  } finally {
    Array.prototype.indexOf = original;
  }
}

const declarations = (n: number, kind: string): string =>
  Array.from({ length: n }, (_, i) => `${kind} v${String(i)}=0;`).join('');

describe('indexed JavaScript scope membership (#507)', () => {
  it.each(['let', 'const', 'var'])(
    'decodes formats with many %s declarations with bounded membership work',
    async (kind) => {
      for (const n of [250, 1000]) {
        const source = declarations(n, kind) + 'storyFormat({name:"Probe",version:"1.0.0",source:"{{STORY_DATA}}"});';
        const measured = await bindingWork(() => parseFormatJSON(source));
        expect(measured.value?.name).toBe('Probe');
        expect(measured.work).toBeLessThan(n * 20);
      }
    },
  );

  it('bounds membership work through compilation and inspection of script templates', async () => {
    for (const n of [250, 1000]) {
      const measured = await bindingWork(async () => {
        const result = await compile({
          sources: [
            { filename: 'story.tw', content: STORY },
            { filename: 'code.js', content: declarations(n, 'let') + 'const value = `</script>[[Start]]`;' },
          ],
          outputMode: 'twine2-archive',
        });
        expect(result.diagnostics).toEqual([]);
        expect(result.output).toContain('v0=0;');
        expect([...storyInspect(result.story).links.values()].flat()).toContain('Start');
      });
      expect(measured.work).toBeLessThan(n * 30);
    }
  });

  it('bounds module export checks and mixed lexical, function, class and var declarations', async () => {
    const n = 1000;
    const code = Array.from(
      { length: n },
      (_, i) =>
        `let l${String(i)}; var v${String(i)}; function f${String(i)}(){} class C${String(i)}{} ` +
        `export {l${String(i)},v${String(i)},f${String(i)},C${String(i)}};`,
    ).join('');
    const measured = await bindingWork(() => AcornParser.parse(code, { ...SCRIPT_OPTIONS, sourceType: 'module' }));
    expect(measured.value.body).toHaveLength(n * 5);
    expect(measured.work).toBeLessThan(n * 30);
  });

  it.each(['class C#{}', 'var v#; let l#;', 'function f#(){} let l#; var v#;'])(
    'bounds mixed script and block scope work for %s',
    async (unit) => {
      const n = 1000;
      const source = Array.from({ length: n }, (_, i) => unit.replaceAll('#', String(i))).join('');
      for (const code of [source, `{${source}}`, `function f(){${source}}`]) {
        const measured = await bindingWork(() => parseScript(code));
        expect(measured.value.ok).toBe(true);
        expect(measured.work).toBeLessThan(n * 30);
      }
    },
  );

  it.each([
    'let a; let a;',
    'let a; var a;',
    'var a; let a;',
    'class a{} function a(){}',
    '{ function a(){} let a; }',
    '{ var a; function a(){} }',
    '{ function a(){} function a(){} }',
    'function a(){} function a(){}',
    'let a; { let a; }',
    'function f(a){var a;}',
    'function f(a){let a;}',
    'try {} catch(a){var a;}',
    'try {} catch({a}){var a;}',
    'try {} catch(a){let a;}',
    'let a; {var a;}',
    'var a; {let a;}',
    'function f(){ {var a;} let a; }',
    'class C { static { let a; var a; } }',
    'export {a}; let a;',
    'export {a}; var a;',
    'export {a}; function a(){}',
    'export {a}; class a{}',
    'export {a};',
    'let a; export {a};',
    'var a; export {a};',
    'let __proto__; var constructor; let toString;',
    'let a; let \\u0061;',
  ])('preserves Acorn binding semantics for %s', (code) => {
    for (const sourceType of ['script', 'module'] as const) {
      const options = { ...SCRIPT_OPTIONS, sourceType };
      let expected;
      try {
        expected = { ok: true, value: Parser.parse(code, options) };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Acorn appends a line/column to its error, while the shared reader reports offsets separately.
        expected = { ok: false, message: error.message.replace(/ \(\d+:\d+\)$/, '') };
      }
      const actual = parseScript(code, options);
      expect(actual.ok ? actual : { ok: false, message: actual.error.message }).toEqual(expected);
    }
  });
});
