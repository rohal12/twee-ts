/**
 * Story model + StoryData JSON marshal/unmarshal.
 * Ported from story.go + storydata.go.
 */
import type { Story, Passage, Diagnostic } from './types.js';
import { validateIFID } from './ifid.js';
import { isStoryPassage, countWords } from './passage.js';

export function createStory(): Story {
  return {
    name: '',
    ifid: '',
    passages: [],
    legacyIFID: '',
    twine1: { settings: new Map() },
    twine2: {
      format: '',
      formatVersion: '',
      options: new Map(),
      start: '',
      tagColors: new Map(),
      zoom: 1,
    },
  };
}

export function storyHas(story: Story, name: string): boolean {
  return story.passages.some((p) => p.name === name);
}

export function storyIndex(story: Story, name: string): number {
  return story.passages.findIndex((p) => p.name === name);
}

export function storyGet(story: Story, name: string): Passage | undefined {
  return story.passages.find((p) => p.name === name);
}

export function storyAppend(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  const i = storyIndex(story, p.name);
  if (i === -1) {
    story.passages.push(p);
  } else {
    diagnostics.push({
      level: 'warning',
      message: `Replacing existing passage "${p.name}" with duplicate.`,
    });
    story.passages[i] = p;
  }
}

export function storyPrepend(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  const i = storyIndex(story, p.name);
  if (i === -1) {
    story.passages.unshift(p);
  } else {
    diagnostics.push({
      level: 'warning',
      message: `Replacing existing passage "${p.name}" with duplicate.`,
    });
    story.passages[i] = p;
  }
}

// --- StoryData JSON ---

interface StoryDataJSON {
  ifid?: string;
  format?: string;
  'format-version'?: string;
  options?: string[];
  start?: string;
  'tag-colors'?: Record<string, string>;
  zoom?: number;
}

export function marshalStoryData(story: Story): string {
  const data: StoryDataJSON = {};
  if (story.ifid) data.ifid = story.ifid;
  if (story.twine2.format) data.format = story.twine2.format;
  if (story.twine2.formatVersion) data['format-version'] = story.twine2.formatVersion;

  const options: string[] = [];
  for (const [opt, val] of story.twine2.options) {
    if (val) options.push(opt);
  }
  if (options.length > 0) data.options = options;

  if (story.twine2.start) data.start = story.twine2.start;

  if (story.twine2.tagColors.size > 0) {
    data['tag-colors'] = Object.fromEntries(story.twine2.tagColors);
  }
  if (story.twine2.zoom !== 1) data.zoom = story.twine2.zoom;

  return JSON.stringify(data, null, '\t');
}

export function unmarshalStoryData(story: Story, json: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (e) {
    return `Cannot unmarshal "StoryData"; ${e instanceof Error ? e.message : String(e)}`;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Cannot unmarshal "StoryData"; expected a JSON object';
  }
  const data = raw as StoryDataJSON;

  if (typeof data.ifid === 'string' && data.ifid) story.ifid = data.ifid.toUpperCase();
  if (typeof data.format === 'string' && data.format) story.twine2.format = data.format;
  if (typeof data['format-version'] === 'string' && data['format-version'])
    story.twine2.formatVersion = data['format-version'];
  if (Array.isArray(data.options)) {
    for (const opt of data.options) {
      if (typeof opt === 'string') story.twine2.options.set(opt, true);
    }
  }
  if (typeof data.start === 'string' && data.start) story.twine2.start = data.start;
  if (typeof data['tag-colors'] === 'object' && data['tag-colors'] !== null && !Array.isArray(data['tag-colors'])) {
    for (const [tag, color] of Object.entries(data['tag-colors'])) {
      if (typeof color === 'string') story.twine2.tagColors.set(tag, color);
    }
  }
  if (typeof data.zoom === 'number' && data.zoom !== 0) story.twine2.zoom = data.zoom;

  return null;
}

// --- StorySettings (legacy) ---

export function unmarshalStorySettings(story: Story, text: string, diagnostics: Diagnostic[]): void {
  const obsolete: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      diagnostics.push({
        level: 'warning',
        message: `Malformed "StorySettings" entry; skipping "${line}".`,
      });
      continue;
    }

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line
      .slice(colonIdx + 1)
      .trim()
      .toLowerCase();

    switch (key) {
      case 'ifid': {
        const err = validateIFID(val);
        if (err === null) {
          story.legacyIFID = val.toUpperCase();
        }
        obsolete.push('"ifid"');
        continue;
      }
      case 'zoom':
        obsolete.push('"zoom"');
        continue;
    }

    story.twine1.settings.set(key, val);
  }

  if (obsolete.length > 0) {
    const entries = obsolete.length === 1 ? 'entry' : 'entries';
    const pronoun = obsolete.length === 1 ? 'it' : 'them';
    diagnostics.push({
      level: 'warning',
      message:
        `Detected obsolete "StorySettings" ${entries}: ${obsolete.join(', ')}. ` +
        `Please remove ${pronoun} from the "StorySettings" special passage.`,
    });
  }
}

/**
 * Process a passage and add it to the story, handling special passages.
 * Creates new passage objects where text is modified rather than mutating the input.
 */
export function storyAdd(story: Story, p: Passage, diagnostics: Diagnostic[]): void {
  let processed = p;

  switch (p.name) {
    case 'StoryIncludes':
      diagnostics.push({
        level: 'warning',
        message:
          'Ignoring "StoryIncludes" compiler special passage; twee-ts allows you to specify project files and/or directories to recursively search.',
      });
      break;

    case 'StoryData': {
      const err = unmarshalStoryData(story, p.text);
      if (err === null) {
        // Validate the IFID if present.
        if (story.ifid.length > 0) {
          const vErr = validateIFID(story.ifid);
          if (vErr !== null) {
            diagnostics.push({
              level: 'error',
              message: `Cannot validate IFID; ${vErr}.`,
            });
          }
        }
        // Rebuild passage contents to normalize.
        processed = { ...p, text: marshalStoryData(story) };
      } else {
        diagnostics.push({
          level: 'error',
          message: `Cannot unmarshal "StoryData" compiler special passage; ${err}.`,
        });
      }
      break;
    }

    case 'StorySettings':
      unmarshalStorySettings(story, p.text, diagnostics);
      break;

    case 'StoryTitle': {
      const trimmed = p.text.trim();
      processed = { ...p, text: trimmed };
      story.name = trimmed;
      break;
    }
  }

  storyAppend(story, processed, diagnostics);
}

/** Get story passage count and word count stats. */
export function getStoryStats(story: Story): { passages: number; storyPassages: number; words: number } {
  let storyPassages = 0;
  let words = 0;
  for (const p of story.passages) {
    if (isStoryPassage(p)) {
      storyPassages++;
      words += countWords(p);
    }
  }
  return { passages: story.passages.length, storyPassages, words };
}
