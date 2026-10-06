/**
 * The time a build is stamped with: the Twine 1 `"TIME"` placeholder and the `created` attribute of Twine 1
 * tiddlers. One build reads it once, so every stamp in one output agrees. `SOURCE_DATE_EPOCH`, the variable the
 * Reproducible Builds project defines (https://reproducible-builds.org/specs/source-date-epoch/), sets it, so
 * that building the same sources twice gives the same bytes.
 */
import { TweeTsError } from './errors.js';

/**
 * The build time: `SOURCE_DATE_EPOCH` (whole seconds since 1970, UTC) when it is set and not empty, else now.
 * A value that is not such a number is a TweeTsError (`INVALID_OPTIONS`), as the specification asks: a
 * build must not silently use another time than the one asked for.
 */
export function buildTime(env: Readonly<Record<string, string | undefined>> = process.env): Date {
  const epoch = env['SOURCE_DATE_EPOCH'];
  if (epoch === undefined || epoch === '') return new Date();
  const seconds = /^[0-9]+$/.test(epoch) ? Number(epoch) : Number.NaN;
  const time = new Date(seconds * 1000);
  if (!Number.isSafeInteger(seconds) || Number.isNaN(time.getTime())) {
    throw new TweeTsError(
      `SOURCE_DATE_EPOCH must be a whole number of seconds since 1970-01-01T00:00:00Z, not ${JSON.stringify(epoch)}.`,
      [],
      { code: 'INVALID_OPTIONS' },
    );
  }
  return time;
}
