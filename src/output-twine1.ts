/**
 * Twine 1 HTML and archive output.
 * Ported from storyout.go.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PassageOmission, ReadonlyPassage, ReadonlyStory, StoryFormatInfo } from './types.js';
import { hasTag, passageToTiddler } from './passage.js';
import { readFormatSource } from './formats.js';
import { headSlot } from './modules.js';
import { fillTemplateParts, literal } from './template.js';
import type { TemplateSlot } from './template.js';
import { jsStringEscape, htmlCommentSanitize } from './escape.js';
import { VERSION } from './version.js';

const CREATOR_NAME = 'twee-ts';

export function toTwine1Archive(story: ReadonlyStory, _startName: string): string {
  const { data, count } = getTwine1PassageChunk(story);
  return `<div id="storeArea" data-size="${count}">${data}</div>\n`;
}

/**
 * Fill the Twine 1 format template. The format's components are inserted first, one after another, as Tweego and
 * Twine 1 do. Then the first of each story placeholder (`"VERSION"`, `"TIME"`, `"START_AT"`, `"STORY_SIZE"`,
 * `"STORY"`), the IFID comment and `head` (before the first closing head tag) are found in one pass, so a start
 * passage name or story data holding a placeholder or a closing head tag stays literal.
 */
export function toTwine1HTML(
  story: ReadonlyStory,
  format: StoryFormatInfo,
  startName: string,
  options?: { readonly head?: string },
): string {
  const formatDir = dirname(format.filename);
  const parentDir = dirname(formatDir);
  let template = readFormatSource(format);
  const { data, count } = getTwine1PassageChunk(story);

  // Component replacements
  template = tryReplaceComponent(template, '"USER_LIB"', join(formatDir, 'userlib.js'), false);
  template = tryReplaceComponent(template, '"ENGINE"', join(parentDir, 'engine.js'), true);
  template = tryReplaceComponent(template, '"SUGARCANE"', join(formatDir, 'code.js'), true);
  template = tryReplaceComponent(template, '"JONAH"', join(formatDir, 'code.js'), true);

  if (story.twine1.settings.get('jquery') === 'on') {
    template = tryReplaceComponent(template, '"JQUERY"', join(parentDir, 'jquery.js'), true);
  }
  if (story.twine1.settings.get('modernizr') === 'on') {
    template = tryReplaceComponent(template, '"MODERNIZR"', join(parentDir, 'modernizr.js'), true);
  }

  // A pre-1.4 format has no "STORY" placeholder: the story data and a footer go after the template.
  const isPre14 = !template.includes('"STORY"');
  const footer = isPre14 ? readFooter(formatDir) : '';

  // The IFID comment and the head content are also looked for in the footer, if the template has no place for them.
  const storeArea = (template + footer).includes('<div id="store-area"')
    ? '<div id="store-area"'
    : '<div id="storeArea"';
  const safeIfid = htmlCommentSanitize(story.ifid);
  const ifid: TemplateSlot | undefined = story.ifid
    ? { pattern: literal(storeArea), occurrences: 'first', replacement: (div) => `<!-- UUID://${safeIfid}// -->${div}` }
    : undefined;
  const late = [ifid, headSlot(options?.head ?? '')].filter((slot) => slot !== undefined);

  // Story instance replacements
  const displayStart = startName === 'Start' ? '' : startName;
  const slots: readonly TemplateSlot[] = [
    firstSlot('"VERSION"', `Compiled with ${CREATOR_NAME}, ${VERSION}`),
    firstSlot('"TIME"', `Built on ${new Date().toUTCString()}`),
    firstSlot('"START_AT"', `"${jsStringEscape(displayStart)}"`),
    firstSlot('"STORY_SIZE"', `"${count}"`),
    firstSlot('"STORY"', data),
    ...late,
  ];

  return fillTemplateParts(
    isPre14
      ? [
          { kind: 'scan', text: template, slots },
          { kind: 'verbatim', text: data },
          { kind: 'scan', text: footer, slots: late },
        ]
      : [{ kind: 'scan', text: template, slots }],
  );
}

/** A slot replacing the first `token` with `value`. */
function firstSlot(token: string, value: string): TemplateSlot {
  return { pattern: literal(token), occurrences: 'first', replacement: () => value };
}

/** The footer of a pre-1.4 format, or the default one when the format has none. */
function readFooter(formatDir: string): string {
  try {
    return readFileSync(join(formatDir, 'footer.html'), 'utf-8');
  } catch {
    return '</div>\n</body>\n</html>\n';
  }
}

/**
 * Why Twine 1 output leaves a passage out of its tiddlers, or `undefined` when the passage is emitted.
 */
export function twine1PassageOmission(p: ReadonlyPassage): PassageOmission | undefined {
  return hasTag(p, 'Twine.private') ? { kind: 'tag', tag: 'Twine.private' } : undefined;
}

function getTwine1PassageChunk(story: ReadonlyStory): { data: string; count: number } {
  const obfuscateRot13 = story.twine1.settings.get('obfuscate') === 'rot13';
  let data = '';
  let count = 0;

  for (const p of story.passages) {
    if (twine1PassageOmission(p) !== undefined) continue;
    count++;
    data += passageToTiddler(p, count, obfuscateRot13);
  }

  return { data, count };
}

function tryReplaceComponent(template: string, placeholder: string, componentPath: string, required: boolean): string {
  if (!template.includes(placeholder)) return template;
  try {
    let content = readFileSync(componentPath, 'utf-8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return template.replace(placeholder, () => content);
  } catch (e) {
    if (required) {
      throw new Error(
        `Required format component not found: ${componentPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return template;
  }
}
