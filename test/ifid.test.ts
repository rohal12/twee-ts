import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createIFID, generateIFID, normalizeIFID, validateIFID } from '../src/ifid.js';

const BARE = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';
const WRAPPED = `UUID://${BARE}//`;

describe('generateIFID', () => {
  it('generates a valid UUID v4 in uppercase', () => {
    const ifid = generateIFID();
    expect(ifid).toHaveLength(36);
    expect(ifid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it('generates unique IFIDs', () => {
    const a = generateIFID();
    const b = generateIFID();
    expect(a).not.toBe(b);
  });
});

describe('validateIFID', () => {
  it('accepts valid UUID v4', () => {
    expect(validateIFID('D674C58C-DEFA-4F70-B7A2-27742230C0FC')).toBeNull();
  });

  it('accepts valid UUID://...// wrapped format', () => {
    expect(validateIFID('UUID://D674C58C-DEFA-4F70-B7A2-27742230C0FC//')).toBeNull();
  });

  it('accepts lowercase hex', () => {
    expect(validateIFID('d674c58c-defa-4f70-b7a2-27742230c0fc')).toBeNull();
  });

  it('rejects invalid length', () => {
    expect(validateIFID('too-short')).toContain('invalid IFID length');
  });

  it('rejects missing hyphens', () => {
    expect(validateIFID('D674C58CXDEFA-4F70-B7A2-27742230C0FC')).toContain('invalid IFID character');
  });

  it('rejects invalid version', () => {
    expect(validateIFID('D674C58C-DEFA-0F70-B7A2-27742230C0FC')).toContain('invalid version');
  });

  it('rejects invalid variant', () => {
    expect(validateIFID('D674C58C-DEFA-4F70-07A2-27742230C0FC')).toContain('invalid variant');
  });

  it('rejects invalid hex characters', () => {
    expect(validateIFID('G674C58C-DEFA-4F70-B7A2-27742230C0FC')).toContain('invalid IFID hex');
  });

  it('validates generated IFIDs', () => {
    for (let i = 0; i < 10; i++) {
      expect(validateIFID(generateIFID())).toBeNull();
    }
  });
});

describe('createIFID', () => {
  it('returns a bare UUID unchanged', () => {
    expect(createIFID(BARE)).toBe(BARE);
  });

  it('uppercases a lowercase bare UUID', () => {
    expect(createIFID(BARE.toLowerCase())).toBe(BARE);
  });

  it('strips the UUID://...// wrapper', () => {
    expect(createIFID(WRAPPED)).toBe(BARE);
  });

  it('strips a lowercase wrapper around a lowercase UUID', () => {
    expect(createIFID(WRAPPED.toLowerCase())).toBe(BARE);
  });

  it('rejects a 45-character value whose wrapper is wrong', () => {
    expect(validateIFID(`UUID:\\\\${BARE}//`)).toBe('invalid IFID UUID://...// format');
    expect(validateIFID(`UUID://${BARE}\\\\`)).toBe('invalid IFID UUID://...// format');
  });

  it('throws on an invalid IFID', () => {
    expect(() => createIFID('not-an-ifid')).toThrow('Invalid IFID: invalid IFID length');
  });
});

describe('normalizeIFID', () => {
  it('turns a wrapped IFID into the uppercase bare UUID', () => {
    expect(normalizeIFID(`uuid://${BARE.toLowerCase()}//`)).toBe(BARE);
  });

  it('uppercases a bare IFID', () => {
    expect(normalizeIFID(BARE.toLowerCase())).toBe(BARE);
  });

  it('keeps an invalid value, uppercased, so validation can report it as written', () => {
    expect(normalizeIFID('uuid://not-an-ifid//')).toBe('UUID://NOT-AN-IFID//');
    expect(normalizeIFID(`UUID://${BARE.slice(0, 35)}X//`)).toBe(`UUID://${BARE.slice(0, 35)}X//`);
  });

  it('gives a value that validates for every valid input', () => {
    for (const input of [BARE, BARE.toLowerCase(), WRAPPED, WRAPPED.toLowerCase()]) {
      expect(validateIFID(normalizeIFID(input))).toBeNull();
      expect(normalizeIFID(input)).toHaveLength(36);
    }
  });

  it('is idempotent and gives the uppercase, unwrapped form for any string', () => {
    const wrapped = fc.uuid().map((uuid) => `uuid://${uuid}//`);
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.uuid(), wrapped), (input) => {
        const stored = normalizeIFID(input);
        expect(normalizeIFID(stored)).toBe(stored);
        expect(stored).toBe(stored.toUpperCase());
        expect(stored.length === 45 && validateIFID(stored) === null).toBe(false);
      }),
    );
  });
});
