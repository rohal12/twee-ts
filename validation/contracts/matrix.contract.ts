/**
 * The matrix itself: case IDs keep their meaning for good, and the cases run against the build.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '@rohal12/twee-ts';
import { allCases } from './cases.js';

/** Revision 1, as the draft validation work declared it against v1.18.1. Never edit; append. */
const REVISION_1 = [
  'WRITE-01: new file',
  'WRITE-02: existing file',
  'WRITE-03: valid relative symlink',
  'WRITE-04: absolute dangling symlink',
  'WRITE-05: relative dangling symlink',
  'WRITE-06: dangling symlink chain',
  'WRITE-07: symlink cycle',
  'TYPE-01: tag append',
  'TYPE-02: tag index assignment',
  'TYPE-03: metadata property assignment',
  'TYPE-04: source property assignment',
  'TYPE-05: name assignment',
  'FORMAT-01: strict object',
  'FORMAT-02: relaxed object',
  'FORMAT-03: comment inside object',
  'FORMAT-04: leading brace comment',
  'FORMAT-05: trailing brace comment',
  'FORMAT-06: surrounding brace comments',
  'FORMAT-07: braces inside a value',
  'RESOLVE-01: local exact',
  'RESOLVE-02: local newer',
  'RESOLVE-03: local older',
  'RESOLVE-04: URL exact',
  'RESOLVE-05: URL newer',
  'RESOLVE-06: URL older',
  'RESOLVE-07: index cache exact',
  'RESOLVE-08: index cache newer',
  'RESOLVE-09: index cache older',
  'HEAD-01: module: ordinary head',
  'HEAD-02: module: comment look-alike',
  'HEAD-03: module: script look-alike',
  'HEAD-04: module: attribute look-alike',
  'HEAD-05: module: quoted head attribute',
  'HEAD-06: client: ordinary head',
  'HEAD-07: client: comment look-alike',
  'HEAD-08: client: script look-alike',
  'HEAD-09: client: attribute look-alike',
  'HEAD-10: client: quoted head attribute',
  'VITE-01: ordinary inline config',
  'VITE-02: inline define',
  'VITE-03: inline alias',
  'VITE-04: inline virtual-module plugin',
  'VITE-05: file config with inline define override',
  'INPUT-01: file and inline normalization',
  'INPUT-02: mixed source precedence',
  'INPUT-03: cold and warm cache parity',
  'INPUT-04: forced change with unchanged mtime',
  'INPUT-05: parse-option invalidation',
  'INPUT-06: generated-name collision',
  'OUTPUT-01: HTML metadata and text round trip',
  'OUTPUT-02: JSON start and debug overrides',
  'OUTPUT-03: private passage omitted',
  'OUTPUT-04: private start rejected',
  'OUTPUT-05: effective Twee metadata round trip',
  'OUTPUT-06: missing IFID reported',
  'CLI-01: compile error preserves previous output',
  'CLI-02: output inside sources excluded on repeat build',
  'ABORT-01: pre-aborted compile',
  'ABORT-02: abort during direct format request',
];

describe('the contract matrix', () => {
  it('keeps every revision 1 case, in order, with its meaning', () => {
    expect(REVISION_1).toHaveLength(59);
    expect(allCases().slice(0, REVISION_1.length)).toEqual(REVISION_1);
  });

  it('gives every case its own ID', () => {
    const ids = allCases().map((c) => c.slice(0, c.indexOf(':')));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('runs the cases against the build in dist/', async () => {
    const built: unknown = await import(pathToFileURL(resolve(import.meta.dirname, '../../dist/index.js')).href);
    expect(built).toHaveProperty('compile', api.compile);
  });
});
