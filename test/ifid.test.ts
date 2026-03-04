import { describe, it, expect } from 'vitest';
import { generateIFID, validateIFID } from '../src/ifid.js';

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
