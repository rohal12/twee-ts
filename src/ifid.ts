/**
 * IFID (Interactive Fiction IDentifier) generation and validation.
 * Ported from ifid.go.
 */
import { randomUUID } from 'node:crypto';

/** Generate a new IFID (UUID v4, uppercase). */
export function generateIFID(): string {
  return randomUUID().toUpperCase();
}

/**
 * Validate an IFID string.
 * Accepts both bare UUIDs and UUID://...// wrapped format.
 * Returns null if valid, or an error message string.
 */
export function validateIFID(ifid: string): string | null {
  let uuid = ifid;

  switch (ifid.length) {
    case 36:
      break;
    case 45: {
      if (ifid.slice(0, 7).toUpperCase() !== 'UUID://' || ifid.slice(43) !== '//') {
        return 'invalid IFID UUID://...// format';
      }
      uuid = ifid.slice(7, 43);
      break;
    }
    default:
      return `invalid IFID length: ${ifid.length}`;
  }

  for (let i = 0; i < uuid.length; i++) {
    const ch = uuid[i]!;
    switch (i) {
      case 8:
      case 13:
      case 18:
      case 23:
        if (ch !== '-') {
          return `invalid IFID character '${ch}' at position ${i + 1}`;
        }
        break;
      case 14:
        if (ch < '1' || ch > '5') {
          return `invalid version '${ch}' at position ${i + 1}`;
        }
        break;
      case 19:
        if (!['8', '9', 'a', 'A', 'b', 'B'].includes(ch)) {
          return `invalid variant '${ch}' at position ${i + 1}`;
        }
        break;
      default:
        if (!/^[0-9a-fA-F]$/.test(ch)) {
          return `invalid IFID hex value '${ch}' at position ${i + 1}`;
        }
        break;
    }
  }

  return null;
}
