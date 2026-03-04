/**
 * Twine 1 HTML and archive output.
 * Ported from storyout.go.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Story, StoryFormatInfo, Diagnostic } from './types.js';
import { hasTag } from './passage.js';
import { passageToTiddler } from './passage.js';
import { readFormatSource } from './formats.js';

const CREATOR_NAME = 'twee-ts';
const CREATOR_VERSION = '0.1.0';

export function toTwine1Archive(story: Story, _startName: string): string {
  const { data, count } = getTwine1PassageChunk(story);
  return `<div id="storeArea" data-size="${count}" hidden>${data}</div>\n`;
}

export function toTwine1HTML(
  story: Story,
  format: StoryFormatInfo,
  startName: string,
  _diagnostics: Diagnostic[],
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

  // Story instance replacements
  const displayStart = startName === 'Start' ? '' : startName;
  template = template.replace('"VERSION"', `Compiled with ${CREATOR_NAME}, ${CREATOR_VERSION}`);
  template = template.replace('"TIME"', `Built on ${new Date().toUTCString()}`);
  template = template.replace('"START_AT"', `"${displayStart}"`);
  template = template.replace('"STORY_SIZE"', `"${count}"`);

  if (template.includes('"STORY"')) {
    template = template.replace('"STORY"', data);
  } else {
    // Pre-1.4 format: append data + footer
    let footer: string;
    try {
      footer = readFileSync(join(formatDir, 'footer.html'), 'utf-8');
    } catch {
      footer = '</div>\n</body>\n</html>\n';
    }
    template += data + footer;
  }

  // IFID replacement
  if (story.ifid) {
    if (template.includes('<div id="store-area"')) {
      template = template.replace('<div id="store-area"', `<!-- UUID://${story.ifid}// --><div id="store-area"`);
    } else {
      template = template.replace('<div id="storeArea"', `<!-- UUID://${story.ifid}// --><div id="storeArea"`);
    }
  }

  return template;
}

function getTwine1PassageChunk(story: Story): { data: string; count: number } {
  let data = '';
  let count = 0;

  for (const p of story.passages) {
    if (hasTag(p, 'Twine.private')) continue;
    count++;
    data += passageToTiddler(p, count);
  }

  return { data, count };
}

function tryReplaceComponent(template: string, placeholder: string, componentPath: string, _required: boolean): string {
  if (!template.includes(placeholder)) return template;
  try {
    let content = readFileSync(componentPath, 'utf-8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return template.replace(placeholder, content);
  } catch {
    return template;
  }
}
