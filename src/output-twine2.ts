/**
 * Twine 2 HTML and archive output.
 * Ported from storyout.go.
 */
import type {
  Diagnostic,
  OmittingTag,
  PassageOmission,
  ReadonlyStory,
  ReadonlyPassage,
  StoryFormatInfo,
} from './types.js';
import { attrEscape, commentSanitize, htmlCommentSanitize, scriptContentEscape, styleContentEscape } from './escape.js';
import { passageToPassagedata, hasTag } from './passage.js';
import { readFormatSource } from './formats.js';
import { storyDataProbe } from './html-structure.js';
import { fillFormatTemplate } from './template.js';
import { codeEscapeDiagnostics, unrepresentableTextDiagnostics } from './html-output-check.js';
import type { CodePart, CodeText } from './html-output-check.js';
import { VERSION } from './version.js';

const CREATOR_NAME = 'Twee-ts';

export function toTwine2Archive(
  story: ReadonlyStory,
  startName: string,
  options?: { readonly sourceInfo?: boolean; readonly diagnostics?: Diagnostic[] },
): string {
  options?.diagnostics?.push(...twine2DataDiagnostics(story));
  return getTwine2DataChunk(story, startName, options) + '\n';
}

/**
 * Fill the Twine 2 format template: every `{{STORY_NAME}}` gets the story name, escaped for the place it is in, and
 * the first `{{STORY_DATA}}` in HTML text gets the story data (as Tweego does), and `head` goes before the closing
 * head tag (see `fillFormatTemplate()`). All three are found in the template before anything is inserted, so a story
 * name, passage text or head content holding a placeholder or a closing head tag stays literal.
 * `options.diagnostics` receives a warning when the format file is not valid UTF-8, any diagnostic about the
 * template, and an error for text that HTML cannot carry.
 */
export function toTwine2HTML(
  story: ReadonlyStory,
  format: StoryFormatInfo,
  startName: string,
  options?: { readonly sourceInfo?: boolean; readonly head?: string; readonly diagnostics?: Diagnostic[] },
): string {
  const template = readFormatSource(format, options?.diagnostics);
  options?.diagnostics?.push(...twine2DataDiagnostics(story));
  // Advertise the format this HTML was built with (as Tweego does), not whatever StoryData named.
  const built = { ...story, twine2: { ...story.twine2, format: format.name, formatVersion: format.version } };
  const filled = fillFormatTemplate({
    template,
    placeholders: [
      { token: '{{STORY_NAME}}', occurrences: 'all', value: { kind: 'text', text: story.name } },
      {
        token: '{{STORY_DATA}}',
        occurrences: 'first',
        value: {
          kind: 'markup',
          html: getTwine2DataChunk(built, startName, options),
          probe: storyDataProbe(
            'twine2',
            story.passages.some((p) => twine2PassageOmission(story, p) === undefined && /[^\t\n\f\r ]/.test(p.text)),
          ),
        },
      },
    ],
    head: options?.head,
    owner: `Story format "${format.name}" ${format.version}`,
  });
  options?.diagnostics?.push(...filled.diagnostics);
  return filled.output;
}

/** Diagnostics for what the Twine 2 story data cannot carry. */
function twine2DataDiagnostics(story: ReadonlyStory): Diagnostic[] {
  const { scripts, stylesheets } = codePassages(story);
  return [
    ...unrepresentableTextDiagnostics(
      story,
      story.passages.filter((p) => !hasTag(p, 'Twine.private')),
    ),
    ...codeEscapeDiagnostics('script', joinCode(scripts, 'script')),
    ...codeEscapeDiagnostics('style', joinCode(stylesheets, 'stylesheet')),
  ];
}

const OMITTING_TAGS: readonly OmittingTag[] = ['Twine.private', 'script', 'stylesheet'];

/**
 * Why Twine 2 output leaves a passage out of its `<tw-passagedata>` elements,
 * or `undefined` when the passage is emitted (and so can be the starting passage).
 */
export function twine2PassageOmission(story: ReadonlyStory, p: ReadonlyPassage): PassageOmission | undefined {
  if (p.name === 'StoryTitle' || p.name === 'StoryData') return { kind: 'special-name', name: p.name };
  const tag = OMITTING_TAGS.find((t) => hasTag(p, t));
  if (tag !== undefined) return { kind: 'tag', tag };
  // Drop empty StorySettings
  if (p.name === 'StorySettings' && story.twine1.settings.size === 0) return { kind: 'empty-story-settings' };
  return undefined;
}

/** The script and stylesheet passages that go into the story's script and style elements. */
function codePassages(story: ReadonlyStory): { scripts: ReadonlyPassage[]; stylesheets: ReadonlyPassage[] } {
  const scripts: ReadonlyPassage[] = [];
  const stylesheets: ReadonlyPassage[] = [];
  for (const p of story.passages) {
    if (hasTag(p, 'Twine.private')) continue;
    if (hasTag(p, 'script')) scripts.push(p);
    else if (hasTag(p, 'stylesheet')) stylesheets.push(p);
  }
  return { scripts, stylesheets };
}

/**
 * The text of the story's script or style element: the text of a single passage, or the passages joined, each after
 * a comment naming it (as Tweego joins them), with where each passage's text starts.
 */
function joinCode(passages: readonly ReadonlyPassage[], kind: 'script' | 'stylesheet'): CodeText {
  const label = (p: ReadonlyPassage): string => `${kind} passage "${p.name}"`;
  const [first, ...rest] = passages;
  if (first === undefined) return { text: '', parts: [{ label: `${kind} element`, start: 0 }] };
  if (rest.length === 0) return { text: first.text, parts: [{ label: label(first), start: 0 }] };
  const header = (p: ReadonlyPassage, n: number): string =>
    `/* twine-user-${kind} #${n}: "${commentSanitize(p.name)}" */\n`;
  let text = header(first, 1);
  const parts: [CodePart, ...CodePart[]] = [{ label: label(first), start: text.length }];
  text += first.text;
  rest.forEach((p, i) => {
    if (!text.endsWith('\n')) text += '\n';
    text += header(p, i + 2);
    parts.push({ label: label(p), start: text.length });
    text += p.text;
  });
  return { text, parts };
}

function getTwine2DataChunk(
  story: ReadonlyStory,
  startName: string,
  options?: { readonly sourceInfo?: boolean },
): string {
  const parts: string[] = [];
  let startID = '';
  let pid = 0;

  const { scripts, stylesheets } = codePassages(story);
  const styleContent = joinCode(stylesheets, 'stylesheet').text;
  parts.push(
    `<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">${styleContentEscape(styleContent)}</style>`,
  );
  const scriptContent = joinCode(scripts, 'script').text;
  parts.push(
    `<script role="script" id="twine-user-script" type="text/twine-javascript">${scriptContentEscape(scriptContent)}</script>`,
  );

  // Tag color elements (only spec-valid colors: 7 named colors or hex values)
  const validTagColors = new Set(['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple']);
  const hexColorPattern = /^#[0-9a-fA-F]{3,8}$/;
  for (const [tag, color] of story.twine2.tagColors) {
    if (validTagColors.has(color) || hexColorPattern.test(color)) {
      parts.push(`<tw-tag name="${attrEscape(tag)}" color="${attrEscape(color)}"></tw-tag>`);
    }
  }

  // Normal passage elements
  pid = 1;
  for (const p of story.passages) {
    if (twine2PassageOmission(story, p) !== undefined) continue;

    parts.push(passageToPassagedata(p, pid, options));
    if (startName === p.name) {
      startID = String(pid);
    }
    pid++;
  }

  // Build options string
  const opts: string[] = [];
  for (const [opt, val] of story.twine2.options) {
    if (val) opts.push(opt);
  }
  const optionsStr = opts.join(' ');

  // Wrap in tw-storydata
  const zoom = String(story.twine2.zoom);

  const wrapper =
    `<!-- UUID://${htmlCommentSanitize(story.ifid)}// -->` +
    `<tw-storydata name="${attrEscape(story.name)}" startnode="${attrEscape(startID)}" ` +
    `creator="${attrEscape(CREATOR_NAME)}" creator-version="${attrEscape(VERSION)}" ` +
    `ifid="${attrEscape(story.ifid)}" zoom="${attrEscape(zoom)}" ` +
    `format="${attrEscape(story.twine2.format)}" ` +
    `format-version="${attrEscape(story.twine2.formatVersion)}" ` +
    `options="${attrEscape(optionsStr)}" tags="${attrEscape(story.twine2.tags)}" hidden>`;

  return wrapper + parts.join('') + '</tw-storydata>';
}
