/**
 * Twine 2 HTML and archive output.
 * Ported from storyout.go.
 */
import type { Story, StoryFormatInfo, Diagnostic } from './types.js';
import { attrEscape, htmlEscape, commentSanitize, htmlCommentSanitize } from './escape.js';
import { passageToPassagedata, hasTag, hasAnyTag } from './passage.js';
import { generateIFID } from './ifid.js';
import { readFormatSource } from './formats.js';
import { VERSION } from './version.js';

const CREATOR_NAME = 'Twee-ts';

export function toTwine2Archive(story: Story, startName: string, diagnostics: Diagnostic[]): string {
  return getTwine2DataChunk(story, startName, diagnostics) + '\n';
}

export function toTwine2HTML(
  story: Story,
  format: StoryFormatInfo,
  startName: string,
  diagnostics: Diagnostic[],
): string {
  let template = readFormatSource(format);

  if (template.includes('{{STORY_NAME}}')) {
    template = template.replaceAll('{{STORY_NAME}}', htmlEscape(story.name));
  }
  if (template.includes('{{STORY_DATA}}')) {
    template = template.replace('{{STORY_DATA}}', getTwine2DataChunk(story, startName, diagnostics));
  }

  return template;
}

function getTwine2DataChunk(story: Story, startName: string, diagnostics: Diagnostic[]): string {
  // Check IFID status and generate if missing.
  ensureIFID(story, diagnostics);

  const parts: string[] = [];
  let startID = '';
  let pid = 0;

  // Gather script and stylesheet passages.
  const scripts: typeof story.passages = [];
  const stylesheets: typeof story.passages = [];
  for (const p of story.passages) {
    if (hasTag(p, 'Twine.private')) continue;
    if (hasTag(p, 'script')) scripts.push(p);
    else if (hasTag(p, 'stylesheet')) stylesheets.push(p);
  }

  // Style element
  let styleContent = '';
  if (stylesheets.length === 1) {
    styleContent = stylesheets[0]?.text ?? '';
  } else if (stylesheets.length > 1) {
    let pidS = 1;
    for (const p of stylesheets) {
      if (pidS > 1 && !styleContent.endsWith('\n')) styleContent += '\n';
      styleContent += `/* twine-user-stylesheet #${pidS}: "${commentSanitize(p.name)}" */\n`;
      styleContent += p.text;
      pidS++;
    }
  }
  parts.push(`<style role="stylesheet" id="twine-user-stylesheet" type="text/twine-css">${styleContent}</style>`);

  // Script element
  let scriptContent = '';
  if (scripts.length === 1) {
    scriptContent = scripts[0]?.text ?? '';
  } else if (scripts.length > 1) {
    let pidS = 1;
    for (const p of scripts) {
      if (pidS > 1 && !scriptContent.endsWith('\n')) scriptContent += '\n';
      scriptContent += `/* twine-user-script #${pidS}: "${commentSanitize(p.name)}" */\n`;
      scriptContent += p.text;
      pidS++;
    }
  }
  parts.push(`<script role="script" id="twine-user-script" type="text/twine-javascript">${scriptContent}</script>`);

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
    if (p.name === 'StoryTitle' || p.name === 'StoryData' || hasAnyTag(p, 'script', 'stylesheet', 'Twine.private')) {
      continue;
    }
    // Drop empty StorySettings
    if (p.name === 'StorySettings' && story.twine1.settings.size === 0) {
      continue;
    }

    parts.push(passageToPassagedata(p, pid));
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
  const options = opts.join(' ');

  // Wrap in tw-storydata
  const zoom = String(story.twine2.zoom);

  const wrapper =
    `<!-- UUID://${htmlCommentSanitize(story.ifid)}// -->` +
    `<tw-storydata name="${attrEscape(story.name)}" startnode="${attrEscape(startID)}" ` +
    `creator="${attrEscape(CREATOR_NAME)}" creator-version="${attrEscape(VERSION)}" ` +
    `ifid="${attrEscape(story.ifid)}" zoom="${attrEscape(zoom)}" ` +
    `format="${attrEscape(story.twine2.format)}" ` +
    `format-version="${attrEscape(story.twine2.formatVersion)}" ` +
    `options="${attrEscape(options)}" tags="${attrEscape(story.twine2.tags)}" hidden>`;

  return wrapper + parts.join('') + '</tw-storydata>';
}

function ensureIFID(story: Story, diagnostics: Diagnostic[]): void {
  if (story.ifid !== '') return;

  if (story.legacyIFID !== '') {
    story.ifid = story.legacyIFID;
    diagnostics.push({
      level: 'warning',
      message: 'Story IFID not found; reusing "ifid" entry from the "StorySettings" special passage.',
    });
  } else {
    const ifid = generateIFID();
    story.ifid = ifid;
    diagnostics.push({
      level: 'error',
      message: `Story IFID not found. Add an IFID to your story: {"ifid":"${ifid}"}`,
    });
  }
}
