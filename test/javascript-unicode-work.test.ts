/** Invalid cooked escapes in tagged templates must not search the remaining program (#579). */
import { describe, expect, it } from 'vitest';
import { Parser } from 'acorn';
import fc from 'fast-check';
import { compile, lint, parseFormatJSON, storyInspect } from '../src/index.js';
import { parseScript, SCRIPT_OPTIONS } from '../src/js-syntax.js';
import { javaScriptStrings } from '../src/javascript-strings.js';
import { STORY } from './helpers/plugins.js';
import { measureTextWork } from './helpers/text-work.js';

const unit = 'String.raw`\\u{`;';

describe('braced Unicode escape scanning (#579)', () => {
  it.each(
    [unit, 'String.raw`\\u{${1}\\u{`;'].flatMap((fragment) => ['', '/* } */'].map((suffix) => ({ fragment, suffix }))),
  )('bounds searches across $fragment with suffix $suffix', ({ fragment, suffix }) => {
    for (const n of [250, 1000]) {
      const source =
        fragment.repeat(n) + suffix + 'storyFormat({name:"Probe",version:"1.0.0",source:"{{STORY_DATA}}"});';
      const measured = measureTextWork(() => parseFormatJSON(source));
      expect(measured.value?.name).toBe('Probe');
      expect(measured.work).toBeLessThan(source.length * 30);
    }
  });

  it('bounds recovery from malformed quoted escapes and still reads later links', () => {
    const source = '"\\u{bad\n'.repeat(1000) + '"[[Start]]";';
    const measured = measureTextWork(() => javaScriptStrings(source));
    expect(measured.value).toContain('[[Start]]');
    expect(measured.work).toBeLessThan(source.length * 30);
  });

  it.each(['', '0', '10ffff', '110000', '000000000000061', '1_2', 'xyz', '12z', 'D800'])(
    'preserves Acorn acceptance and cooked values for %j',
    (digits) => {
      for (const source of [
        `"\\u{${digits}}";`,
        `String.raw\`\\u{${digits}}\`;`,
        `String.raw\`\\u{${digits}\${1}\\u{\`;`,
        `var \\u{${digits}} = 1;`,
      ]) {
        let accepted = true;
        let expected;
        try {
          expected = Parser.parse(source, SCRIPT_OPTIONS);
        } catch {
          accepted = false;
        }
        const actual = parseScript(source);
        expect(actual.ok).toBe(accepted);
        expect(actual.ok && actual.value).toEqual(accepted ? expected : false);
      }
    },
  );

  it('decodes arbitrary valid code points like Acorn', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x10ffff }), (code) => {
        const source = `"\\u{${code.toString(16)}}";`;
        expect(parseScript(source)).toEqual({ ok: true, value: Parser.parse(source, SCRIPT_OPTIONS) });
      }),
    );
  });

  it('preserves compilation, inspection and lint for many tagged templates', async () => {
    const sources = [
      { filename: 'story.tw', content: STORY },
      { filename: 'code.js', content: unit.repeat(1000) + 'const value = "[[Start]]</script>";' },
    ];
    const result = await compile({ sources, outputMode: 'twine2-archive' });
    expect(result.diagnostics).toEqual([]);
    expect([...storyInspect(result.story).links.values()].flat()).toContain('Start');
    expect((await lint({ sources })).diagnostics).toEqual([]);
  });
});
