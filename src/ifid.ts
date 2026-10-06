/**
 * IFID (Interactive Fiction IDentifier) generation and validation.
 * Ported from ifid.go.
 */
import { randomUUID } from 'node:crypto';
import type { IFID } from './types.js';

/** Generate a new IFID (UUID v4, uppercase). */
export function generateIFID(): IFID {
  return randomUUID().toUpperCase() as IFID;
}

/**
 * Validate and brand an IFID string. Throws on invalid input.
 * Returns the IFID in its stored form (see `normalizeIFID`).
 */
export function createIFID(value: string): IFID {
  const err = validateIFID(value);
  if (err) throw new Error(`Invalid IFID: ${err}`);
  return normalizeIFID(value);
}

/** Length of the `UUID://...//` wrapper around a 36-character UUID. */
const WRAPPED_LENGTH = 45;

/**
 * Bring an IFID into the form the story model stores and every output writes: the uppercase
 * bare UUID. A valid `UUID://...//` wrapped IFID loses its wrapper; outputs that need the wrapper
 * (the Treaty of Babel comment) add exactly one. Twine 2 IFIDs use only capital letters, so the
 * value is uppercased, as Tweego does. An invalid value is only uppercased, so that validation
 * reports it as written.
 */
export function normalizeIFID(value: string): IFID {
  const upper = value.toUpperCase();
  const bare = upper.length === WRAPPED_LENGTH && validateIFID(upper) === null ? upper.slice(7, 43) : upper;
  return bare as IFID;
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
    const ch = uuid.charAt(i);
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
