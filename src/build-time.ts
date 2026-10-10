/**
 * The time a build is stamped with: the Twine 1 `"TIME"` placeholder and the `created` attribute of Twine 1
 * tiddlers. One build reads it once, so every stamp in one output agrees. `SOURCE_DATE_EPOCH`, the variable the
 * Reproducible Builds project defines (https://reproducible-builds.org/specs/source-date-epoch/), sets it, so
 * that building the same sources twice gives the same bytes.
 */
import { TweeTsError } from './errors.js';

/**
 * The last second Twine 1's time stamp can hold, 9999-12-31T23:59:59Z: its `created` attribute has four digits
 * for the year (YYYYMMDDHHMM).
 */
const LAST_SECOND = 253402300799;

/**
 * The build time: `SOURCE_DATE_EPOCH` (whole seconds since 1970, UTC) when it is set and not empty, else now.
 * Only the output that is stamped (Twine 1) reads it. A value that is not such a number, or is after the year
 * 9999, is a TweeTsError (`INVALID_OPTIONS`), as the specification asks: a build must not silently use another
 * time than the one asked for.
 */
export function buildTime(env: Readonly<Record<string, string | undefined>> = process.env): Date {
  const epoch = env['SOURCE_DATE_EPOCH'];
  if (epoch === undefined || epoch === '') return new Date();
  const seconds = /^[0-9]+$/.test(epoch) ? Number(epoch) : Number.NaN;
  if (!(seconds <= LAST_SECOND)) {
    throw new TweeTsError(
      `SOURCE_DATE_EPOCH must be a whole number of seconds since 1970-01-01T00:00:00Z, at most ${LAST_SECOND} (the end of the year 9999), not ${JSON.stringify(epoch)}.`,
      [],
      { code: 'INVALID_OPTIONS' },
    );
  }
  return new Date(seconds * 1000);
}
