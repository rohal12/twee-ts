/**
 * Twine 1 HTML and archive output.
 * Ported from storyout.go.
 */
import { join, dirname } from 'node:path';
import type { Diagnostic, PassageOmission, ReadonlyPassage, ReadonlyStory, StoryFormatInfo } from './types.js';
import { readUTF8 } from './util.js';
import { hasTag, isObfuscatable, passageToTiddler } from './passage.js';
import { readFormatComponent, readFormatSource } from './formats.js';
import { DEFAULT_TWINE1_FOOTER, storyDataProbe, twine1ArchiveStoreArea } from './html-structure.js';
import { fillFormatTemplate } from './template.js';
import type { Placeholder } from './template.js';
import { htmlCommentSanitize, rot13 } from './escape.js';
import { checkInsertedText, unrepresentableTextDiagnostics } from './html-output-check.js';
import { isRot13Obfuscated } from './twine1-obfuscation.js';
import { VERSION } from './version.js';
import { TweeTsError } from './errors.js';
import { buildTime } from './build-time.js';
import { failureOfRead } from './input-policy.js';

const CREATOR_NAME = 'twee-ts';

export function toTwine1Archive(
  story: ReadonlyStory,
  _startName: string,
  options?: { readonly diagnostics?: Diagnostic[]; readonly time?: Date },
): string {
  const { data, count, diagnostics } = getTwine1PassageChunk(story, options?.time ?? buildTime());
  options?.diagnostics?.push(...diagnostics);
  return twine1ArchiveStoreArea(count, data);
}

/**
 * Fill the Twine 1 format template. The format's components are inserted first, one after another, as Tweego and
 * Twine 1 do. Then the story placeholders (`"VERSION"`, `"TIME"`, `"START_AT"`, `"STORY_SIZE"`, `"STORY"`), the IFID
 * comment (before the store area element) and `head` (at the end of the head) are placed by the template's HTML
 * structure (see `fillFormatTemplate()`), so a start passage name or story data holding a placeholder or a closing
 * head tag stays literal. `options.diagnostics` receives a warning for each format file that is not valid UTF-8, any
 * diagnostic about the template, and an error for text that HTML cannot carry.
 */
export function toTwine1HTML(
  story: ReadonlyStory,
  format: StoryFormatInfo,
  startName: string,
  options?: { readonly head?: string; readonly diagnostics?: Diagnostic[]; readonly time?: Date },
): string {
  const time = options?.time ?? buildTime();
  const formatDir = dirname(format.filename);
  const parentDir = dirname(formatDir);
  const diagnostics = options?.diagnostics;
  let template = readFormatSource(format, diagnostics);
  checkInsertedText(diagnostics, `The story format "${format.name}"`, template);
  const chunk = getTwine1PassageChunk(story, time);
  const { data, count } = chunk;
  diagnostics?.push(...chunk.diagnostics);

  // Component replacements
  // The format's own components come from the verified download when it is one, else from its folder.
  const own = (file: string) => (): string | undefined => readFormatComponent(format, file, diagnostics);
  template = tryReplaceComponent(
    template,
    '"USER_LIB"',
    join(formatDir, 'userlib.js'),
    false,
    diagnostics,
    own('userlib.js'),
  );
  template = tryReplaceComponent(template, '"ENGINE"', join(parentDir, 'engine.js'), true, diagnostics);
  template = tryReplaceComponent(
    template,
    '"SUGARCANE"',
    join(formatDir, 'code.js'),
    true,
    diagnostics,
    own('code.js'),
  );
  template = tryReplaceComponent(template, '"JONAH"', join(formatDir, 'code.js'), true, diagnostics, own('code.js'));

  if (story.twine1.settings.get('jquery') === 'on') {
    template = tryReplaceComponent(template, '"JQUERY"', join(parentDir, 'jquery.js'), true, diagnostics);
  }
  if (story.twine1.settings.get('modernizr') === 'on') {
    template = tryReplaceComponent(template, '"MODERNIZR"', join(parentDir, 'modernizr.js'), true, diagnostics);
  }

  // A pre-1.4 format has no "STORY" placeholder: the story data and a footer go after the template.
  const isPre14 = !template.includes('"STORY"');
  const footer = isPre14 ? readFooter(formatDir, diagnostics) : '';

  // Story instance replacements. "START_AT" is a JavaScript string literal (`testplay = "START_AT";` in Sugarcane),
  // and "STORY_SIZE" a quoted attribute value (`data-size="STORY_SIZE"`); their quotes are kept as theirs.
  const displayStart = startName === 'Start' ? '' : startName;
  const probe = storyDataProbe('twine1', chunk.hasText);
  const storyData: readonly Placeholder[] = isPre14
    ? []
    : [{ token: '"STORY"', occurrences: 'first', value: { kind: 'markup', html: data, probe } }];
  const filled = fillFormatTemplate({
    template,
    placeholders: [
      {
        token: '"VERSION"',
        occurrences: 'first',
        value: { kind: 'text', text: `Compiled with ${CREATOR_NAME}, ${VERSION}` },
      },
      { token: '"TIME"', occurrences: 'first', value: { kind: 'text', text: `Built on ${time.toUTCString()}` } },
      { token: '"START_AT"', occurrences: 'first', value: { kind: 'quoted', text: displayStart } },
      { token: '"STORY_SIZE"', occurrences: 'first', value: { kind: 'quoted', text: String(count) } },
      ...storyData,
    ],
    // The IFID comment and the head content may go into the footer, if the template has no place for them.
    tail: isPre14 ? { data, footer, probe } : undefined,
    head: options?.head,
    beforeStoreArea: story.ifid ? `<!-- UUID://${htmlCommentSanitize(story.ifid)}// -->` : undefined,
    owner: `Story format "${format.name}"`,
  });
  diagnostics?.push(...filled.diagnostics);
  return filled.output;
}

/**
 * The footer of a pre-1.4 format, or the default one when the format has none (nothing at its path, or a dangling
 * link, as Tweego tells them). A footer that is there but can't be read is a TweeTsError (see `componentUnavailable()`).
 */
function readFooter(formatDir: string, diagnostics: Diagnostic[] | undefined): string {
  const path = join(formatDir, 'footer.html');
  let footer: string;
  try {
    footer = readUTF8(path, diagnostics);
  } catch (e) {
    if (isAbsent(path, e)) return DEFAULT_TWINE1_FOOTER;
    throw componentUnavailable('Format component cannot be read', path, e);
  }
  checkInsertedText(diagnostics, `The story format component "${path}"`, footer);
  return footer;
}

/**
 * Whether reading an optional format component failed because nothing is at its path: only then does the format
 * do without it, as in Tweego (`os.IsNotExist`, which a dangling link also gives). A folder, a file it may not read
 * or bytes it can't decode are errors, so the output never silently lacks a part of the format.
 */
function isAbsent(path: string, e: unknown): boolean {
  const failure = failureOfRead(path, e);
  return failure === 'missing' || failure === 'dangling-link';
}

/** The TweeTsError for a format component that can't be used. */
function componentUnavailable(what: string, path: string, e: unknown): TweeTsError {
  return new TweeTsError(`${what}: ${path}: ${e instanceof Error ? e.message : String(e)}`, [], {
    code: 'FORMAT_UNAVAILABLE',
    cause: e,
  });
}

/**
 * Why Twine 1 output leaves a passage out of its tiddlers, or `undefined` when the passage is emitted.
 */
export function twine1PassageOmission(p: ReadonlyPassage): PassageOmission | undefined {
  return hasTag(p, 'Twine.private') ? { kind: 'tag', tag: 'Twine.private' } : undefined;
}

/**
 * The tiddlers of the passages Twine 1 output writes, their count, and the diagnostics about them.
 *
 * The tiddlers are ROT13-obfuscated when the StorySettings tiddler that is written says `obfuscate:rot13`, since
 * that is what tells the engine to decode them; a StorySettings passage left out (`Twine.private`) cannot, so then
 * nothing is obfuscated, with a warning. Obfuscation that would turn a name into `StorySettings` or a tag into
 * `Twine.image` is an error: the engine reads such a tiddler as the settings, or as an image it doesn't decode.
 */
function getTwine1PassageChunk(
  story: ReadonlyStory,
  time: Date,
): {
  data: string;
  count: number;
  hasText: boolean;
  diagnostics: Diagnostic[];
} {
  const written = story.passages.filter((p) => twine1PassageOmission(p) === undefined);
  const obfuscateRot13 = isRot13Obfuscated(written);
  const diagnostics = unrepresentableTextDiagnostics(story, written, ['position']);
  if (!obfuscateRot13 && story.twine1.settings.get('obfuscate') === 'rot13') {
    diagnostics.push({
      level: 'warning',
      message:
        'The "StorySettings" passage says "obfuscate:rot13", but it is not written to the output (it is tagged ' +
        '"Twine.private"), so the story engine could not decode obfuscated passages; they are written unobfuscated.',
    });
  }
  if (obfuscateRot13) diagnostics.push(...obfuscationCollisions(written));
  const data = written.map((p, i) => passageToTiddler(p, i + 1, obfuscateRot13, time)).join('');
  const hasText = written.some((p) => /[^\t\n\f\r ]/.test(p.text));
  return { data, count: written.length, hasText, diagnostics };
}

/** Errors for passages whose ROT13-encoded name or tag is one the Twine 1 engine reads unencoded. */
function obfuscationCollisions(passages: readonly ReadonlyPassage[]): Diagnostic[] {
  return passages.filter(isObfuscatable).flatMap((p): Diagnostic[] => {
    const reserved = [rot13(p.name) === 'StorySettings' ? `its name to "StorySettings"` : undefined]
      .concat(p.tags.map((tag) => (rot13(tag) === 'Twine.image' ? `its tag "${tag}" to "Twine.image"` : undefined)))
      .filter((what) => what !== undefined);
    return reserved.map((what) => ({
      level: 'error',
      message:
        `Passage "${p.name}" cannot be obfuscated: ROT13 turns ${what}, which the Twine 1 engine reads ` +
        'unencoded, so it would not decode the passage. Rename it, or turn off "obfuscate:rot13".',
    }));
  });
}

function tryReplaceComponent(
  template: string,
  placeholder: string,
  componentPath: string,
  required: boolean,
  diagnostics: Diagnostic[] | undefined,
  downloaded?: () => string | undefined,
): string {
  if (!template.includes(placeholder)) return template;
  try {
    const content = downloaded?.() ?? readUTF8(componentPath, diagnostics);
    checkInsertedText(diagnostics, `The story format component "${componentPath}"`, content);
    return template.replace(placeholder, () => content);
  } catch (e) {
    if (required) throw componentUnavailable('Required format component not found', componentPath, e);
    // An optional component is left out only when it is absent (see isAbsent()).
    if (isAbsent(componentPath, e)) return template;
    throw componentUnavailable('Format component cannot be read', componentPath, e);
  }
}
