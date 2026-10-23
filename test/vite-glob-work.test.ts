import { describe, expect, it, vi } from 'vitest';
import { getLineInfo } from 'acorn';
import { AcornParser } from '../src/js-syntax.js';
import { globCalls, moduleGlobScopes } from '../src/plugins/vite-glob.js';
import { measureTextWork } from './helpers/text-work.js';

const bad = 'void import.meta.glob("./files/*.js", {query: /x/});';

describe('glob diagnostic location work (#508)', () => {
  it.each(['', '\n', '\r', '\r\n', '\u2028', '\u2029'])('indexes many locations separated by %j', async (separator) => {
    const n = 1000;
    const code = (bad + separator).repeat(n);
    const warn = vi.fn();
    const measured = measureTextWork(() =>
      moduleGlobScopes({ resolve: () => Promise.resolve(null), warn }, code, 'entry.js', '/p'),
    );
    expect(await measured.value).toEqual([]);
    const expected = Array.from({ length: n }, (_, i) => {
      const position = getLineInfo(code, i * (bad.length + separator.length) + 5);
      return `${String(position.line)}:${String(position.column + 1)}`;
    }).join(', ');
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`call at ${expected} of entry.js`));
    expect(measured.work).toBeLessThan(code.length * 50);
  });

  it('does not warn about many readable calls', async () => {
    const warn = vi.fn();
    const code = 'import.meta.glob("!./files/*.js");'.repeat(1000);
    expect(await moduleGlobScopes({ resolve: () => Promise.resolve(null), warn }, code, 'entry.js', '/p')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('aggregate glob recovery work (#509)', () => {
  it.each([
    ['export {missing};\n/* ', ' */'],
    ['type T = string;\n/* ', ' */'],
    ['<script lang="ts">/* ', ' */</script>'],
    ['return;\n"', '"'],
    ['type T = string;\n', ''],
  ])('bounds repeated unclosed calls after %s', (prefix, suffix) => {
    const n = 1000;
    const code = prefix + 'import.meta.glob('.repeat(n) + suffix;
    let tokens = 0;
    const real = AcornParser.tokenizer.bind(AcornParser);
    const spy = vi.spyOn(AcornParser, 'tokenizer').mockImplementation((...args) => {
      const reader = real(...args);
      const getToken = reader.getToken.bind(reader);
      reader.getToken = () => {
        tokens += 1;
        return getToken();
      };
      return reader;
    });
    try {
      const measured = measureTextWork(() => globCalls(code));
      expect(measured.value.calls).toEqual([]);
      expect(measured.value.unreadable.length).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(code.length * 40);
      expect(measured.work).toBeLessThan(code.length * 100);
    } finally {
      spy.mockRestore();
    }
  });

  it('diagnoses the aggregate limit explicitly', async () => {
    const warn = vi.fn();
    const code = 'export {missing}; /* ' + 'import.meta.glob('.repeat(1000) + ' */';
    expect(await moduleGlobScopes({ resolve: () => Promise.resolve(null), warn }, code, 'entry.js', '/p')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovery work limit'));
  });

  it('bounds repeated parsing of nested closed calls', () => {
    const code = 'type T = string; ' + 'import.meta.glob('.repeat(1000) + '"./*.js"' + ')'.repeat(1000);
    const measured = measureTextWork(() => globCalls(code));
    expect(measured.value.recoveryLimited).toBe(true);
    expect(measured.work).toBeLessThan(code.length * 100);
  });

  it('recovers many disjoint TypeScript calls without exhausting the allowance', () => {
    const code = 'type T = string; ' + 'import.meta.glob<Mod>("./*.js");'.repeat(1000);
    const reading = globCalls(code);
    expect(reading.calls).toHaveLength(1000);
    expect(reading.unreadable).toEqual([]);
    expect(reading.recoveryLimited).toBeUndefined();
  });

  it('keeps later recoverable calls after malformed arguments', () => {
    const code = "type T = string; import.meta.glob(@); import.meta.glob('./later/*.js');";
    expect(globCalls(code)).toEqual({
      calls: [{ patterns: ['./later/*.js'], base: undefined, exhaustive: false }],
      unreadable: [17],
    });
  });

  it('ignores apparent calls in valid module comments and strings', () => {
    const code = '/* ' + 'import.meta.glob('.repeat(1000) + ' */\nconst s="import.meta.glob(";';
    expect(globCalls(code)).toEqual({ calls: [], unreadable: [] });
  });
});
