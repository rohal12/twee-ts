/**
 * Twine HTML decompiler: parse compiled Twine 2 or Twine 1 HTML back into a Story model.
 * Ported from storyload.go:loadHTML().
 *
 * The HTML is read as a browser reads it (with parse5, scripting enabled; see `html-structure.ts`), so the story is
 * the one a story format finds: the first `tw-storydata` element (or Twine 1 store area) outside template contents,
 * comments and raw text; line breaks normalized and NUL handled as the HTML input stream does; and each passage's
 * text its `textContent`.
 *
 * Round trip: decompiling compiled HTML gives the compiled story back, except for code that the compiler escapes for
 * its element (`</script`, `</style` and, in double-escaped script text, `<!--` come back with a backslash after the
 * `<`; see `scriptContentEscape()`), the names of script and stylesheet passages (joined into one element), and what
 * HTML cannot carry (see `html-output-check.ts`), which compiling reports.
 */
import type { Passage, PassageMetadata, Diagnostic, DecompileOptions, Story } from './types.js';
import { createStory, storyAdd, storyPrepend, marshalStoryData, freeName } from './story.js';
import { rot13, tiddlerUnescape } from './escape.js';
import { normalizeIFID, validateIFID } from './ifid.js';
import { isObfuscatable, withGeneratedName } from './passage.js';
import {
  attributeOf,
  childElements,
  findStoreArea,
  findStories,
  findStoryData,
  isTiddler,
  parseHtml,
  textContent,
} from './html-structure.js';
import type { HtmlElement } from './html-structure.js';
import { isRot13Obfuscated } from './twine1-obfuscation.js';
import { splitTweeFields, trimTweeSpace } from './twee-syntax.js';

export interface DecompileResult {
  story: Story;
  diagnostics: Diagnostic[];
}

/** What decompiling reports beyond what it reads. */
interface DecompileChecks {
  /** Report a missing or invalid `tw-storydata` IFID. */
  readonly ifid: boolean;
}

/**
 * Parse a Twine 2 or Twine 1 compiled HTML file back into a Story model.
 * Tweego always trims passage text; here `trim: false` keeps it exactly, as for Twee sources.
 * A missing or invalid `tw-storydata` IFID is reported as a warning; an invalid one is kept as
 * written (uppercased), a missing one stays empty.
 */
export function decompileHTML(html: string, options: DecompileOptions = {}): DecompileResult {
  return decompile(html, options, { ifid: true });
}

/**
 * `decompileHTML()` for loading an HTML file into a compile. The importer's StoryData passage is
 * checked when it is added to the story being compiled, which reports a missing or invalid IFID,
 * so the IFID is not reported here as well.
 */
export function decompileHTMLForImport(html: string, options: DecompileOptions = {}): DecompileResult {
  return decompile(html, options, { ifid: false });
}

function decompile(html: string, options: DecompileOptions, checks: DecompileChecks): DecompileResult {
  const diagnostics: Diagnostic[] = [];
  const story = createStory();
  const passageText = options.trim === false ? (text: string) => text : trimTweeSpace;

  const doc = parseHtml(html, false);

  // Try Twine 2 first (tw-storydata), then the Twine 1 store area.
  const twine2Data = findStoryData(doc);
  const twine1Data = twine2Data ? undefined : findStoreArea(doc);
  if (twine2Data) {
    decompileTwine2(twine2Data, story, passageText, checks, diagnostics);
  } else if (twine1Data) {
    decompileTwine1(twine1Data, story, passageText, diagnostics);
  } else {
    diagnostics.push({ level: 'error', message: 'Malformed HTML source; story data not found.' });
    return { story, diagnostics };
  }
  diagnostics.push(...otherStoriesDiagnostics(findStories(doc), twine2Data ?? twine1Data, story.name));
  return { story, diagnostics };
}

/**
 * A warning when the document holds `stories` besides the one read (`read`, named `name`): a Twine 2 library
 * archive, or files joined together. Only the first is read, as a story format and Tweego read it.
 */
function otherStoriesDiagnostics(
  stories: readonly HtmlElement[],
  read: HtmlElement | undefined,
  name: string,
): Diagnostic[] {
  const others = stories.filter((element) => element !== read).length;
  if (others === 0) return [];
  const which = name === '' ? 'one of them' : JSON.stringify(name);
  return [{ level: 'warning', message: `The HTML holds ${String(others + 1)} stories; only ${which} is read.` }];
}

/** Turns stored passage text into passage text: trimmed at both ends, or kept as is. */
type PassageText = (text: string) => string;

/** Split a space-separated attribute value (tags, options) at white space, as Twee splits tags. */
function splitList(value: string | undefined): string[] {
  return splitTweeFields(value ?? '');
}

function decompileTwine2(
  storyData: HtmlElement,
  story: Story,
  passageText: PassageText,
  checks: DecompileChecks,
  diagnostics: Diagnostic[],
): void {
  // Parse tw-storydata attributes.
  let startnode = 0;
  let startFound = false;
  const attr = (name: string): string => attributeOf(storyData, name) ?? '';

  if (attr('name')) story.name = attr('name');
  if (attr('startnode')) {
    const parsed = parseInteger(attr('startnode'));
    if (parsed === undefined) {
      diagnostics.push({
        level: 'warning',
        message: `Cannot parse "tw-storydata" content attribute "startnode" as an integer; value "${attr('startnode')}".`,
      });
    } else {
      startnode = parsed;
    }
  }
  if (attr('ifid')) story.ifid = normalizeIFID(attr('ifid'));
  if (checks.ifid) diagnostics.push(...storyDataIFIDDiagnostics(attr('ifid')));
  if (attr('zoom')) {
    const parsed = parseDecimal(attr('zoom'));
    if (parsed === undefined) {
      diagnostics.push({
        level: 'warning',
        message: `Cannot parse "tw-storydata" content attribute "zoom" as a float; value "${attr('zoom')}".`,
      });
    } else {
      story.twine2.zoom = parsed;
    }
  }
  if (attr('tags')) story.twine2.tags = attr('tags');
  if (attr('format')) story.twine2.format = attr('format');
  if (attr('format-version')) story.twine2.formatVersion = attr('format-version');
  for (const opt of splitList(attr('options'))) story.twine2.options.set(opt, true);

  // The story stylesheet and script get generated passage names. Ordinary passages may use those
  // names too, so reserve every real passage name first and give the code passages names left free.
  const children = childElements(storyData);
  const takenNames = new Set(children.filter((node) => node.tagName === 'tw-passagedata').map(passageDataName));

  for (const node of children) {
    switch (node.tagName) {
      case 'style':
      case 'script': {
        const content = textContent(node);
        // Whitespace alone is no stylesheet or script, whether or not the text is trimmed.
        if (trimTweeSpace(content).length === 0) continue;
        const text = passageText(content);
        const base = node.tagName === 'style' ? 'Story Stylesheet' : 'Story JavaScript';
        const name = freeName(base, (n) => !takenNames.has(n));
        takenNames.add(name);
        const tags = node.tagName === 'style' ? ['stylesheet'] : ['script'];
        // Marked as generated, so that it also yields to passages of other files (see storyAdd()).
        storyAdd(story, withGeneratedName({ name, tags, text }, { kind: 'code', base }), diagnostics);
        break;
      }

      case 'tw-tag': {
        const tagName = attributeOf(node, 'name') ?? '';
        const tagColor = attributeOf(node, 'color') ?? '';
        if (tagName) story.twine2.tagColors.set(tagName, tagColor);
        break;
      }

      case 'tw-passagedata': {
        let pid = 0;
        const name = passageDataName(node);
        const tags = splitList(attributeOf(node, 'tags'));
        const metadata: PassageMetadata = {};
        const pidValue = attributeOf(node, 'pid') ?? '';

        if (pidValue) {
          const parsed = parseInteger(pidValue);
          if (parsed === undefined) {
            diagnostics.push({
              level: 'warning',
              message: `Cannot parse "tw-passagedata" content attribute "pid" as an integer; value "${pidValue}".`,
            });
          } else {
            pid = parsed;
          }
        }

        const position = attributeOf(node, 'position');
        const size = attributeOf(node, 'size');
        if (position) metadata.position = position;
        if (size) metadata.size = size;

        const text = passageText(textContent(node));
        const own = ownName(name, text, story, takenNames, diagnostics);
        if (pid === startnode && pid !== 0) {
          story.twine2.start = own;
          startFound = true;
        }
        const passage: Passage = { name: own, tags, text };
        if (metadata.position || metadata.size) {
          passage.metadata = metadata;
        }
        storyAdd(story, passage, diagnostics);
        break;
      }

      default:
        // Other elements inside tw-storydata are not part of the story.
        break;
    }
  }

  if (startnode !== 0 && !startFound) {
    diagnostics.push({
      level: 'warning',
      message: `The "tw-storydata" content attribute "startnode" is ${startnode}, but no "tw-passagedata" has that "pid"; the story has no start passage.`,
    });
  }

  // Prepend StoryData passage with serialized metadata.
  storyPrepend(story, { name: 'StoryData', tags: [], text: marshalStoryData(story) }, diagnostics);
}

/** An integer as Go's `strconv.Atoi` reads it (an optional sign and ASCII digits), within JavaScript's safe range. */
function parseInteger(value: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A finite decimal number (`0.6`, `.5`, `6e-1`), with nothing else around it. */
function parseDecimal(value: string): number | undefined {
  if (!/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** What the special passages that the `tw-storydata` attributes stand for hold. */
const ATTRIBUTE_PASSAGES: Readonly<Record<string, string>> = {
  StoryData: 'the story metadata',
  StoryTitle: 'the story name',
};

/**
 * The name a `tw-passagedata` passage keeps in the story. In Twine 2 HTML the story metadata and name are the
 * `tw-storydata` attributes, and a passage named StoryData or StoryTitle is an ordinary passage; in Twee those
 * names are the special passages that hold them. So such a passage, unless it is a StoryTitle that holds the
 * story name, takes the first free name (`StoryData 2`, …), with a warning, and the attributes keep deciding.
 */
function ownName(name: string, text: string, story: Story, taken: Set<string>, diagnostics: Diagnostic[]): string {
  const holds = Object.hasOwn(ATTRIBUTE_PASSAGES, name) ? ATTRIBUTE_PASSAGES[name] : undefined;
  if (holds === undefined || (name === 'StoryTitle' && trimTweeSpace(text) === story.name)) return name;
  const free = freeName(name, (n) => !taken.has(n));
  taken.add(free);
  diagnostics.push({
    level: 'warning',
    message: `Passage "${name}" renamed to "${free}": in Twee, "${name}" is the special passage that holds ${holds}, which this file's "tw-storydata" attributes give. Links to it must be changed by hand.`,
  });
  return free;
}

function passageDataName(node: HtmlElement): string {
  return attributeOf(node, 'name') ?? '';
}

/** Diagnostics for the `ifid` attribute of `tw-storydata`; `value` is empty when it is missing. */
function storyDataIFIDDiagnostics(value: string): Diagnostic[] {
  if (value === '') {
    return [
      {
        level: 'warning',
        message: 'Story IFID not found; the "tw-storydata" content attribute "ifid" is missing or empty.',
      },
    ];
  }
  const err = validateIFID(value);
  if (err === null) return [];
  return [
    {
      level: 'warning',
      message: `Cannot parse "tw-storydata" content attribute "ifid" as an IFID; value "${value}" (${err}).`,
    },
  ];
}

function decompileTwine1(
  storeArea: HtmlElement,
  story: Story,
  passageText: PassageText,
  diagnostics: Diagnostic[],
): void {
  const passages = childElements(storeArea)
    .filter(isTiddler)
    .map((node) => tiddlerToPassage(node, passageText));

  // When StorySettings says `obfuscate:rot13`, Twine 1.4 (and twee-ts) ROT13-encode the name, tags and text of
  // every obfuscatable tiddler, so read the settings before adding (and so interpreting) anything else. Whether a
  // tiddler is obfuscatable is decided on its stored name and tags, which such tiddlers keep unencoded.
  const obfuscated = isRot13Obfuscated(passages);
  for (const p of passages) {
    const passage =
      obfuscated && isObfuscatable(p) ? { ...p, name: rot13(p.name), tags: p.tags.map(rot13), text: rot13(p.text) } : p;
    storyAdd(story, passage, diagnostics);
  }
}

function tiddlerToPassage(node: HtmlElement, passageText: PassageText): Passage {
  const name = attributeOf(node, 'tiddler') ?? '';
  const tags = splitList(attributeOf(node, 'tags'));
  const text = passageText(tiddlerUnescape(textContent(node)));

  const passage: Passage = { name, tags, text };
  const position = attributeOf(node, 'twine-position');
  if (position) {
    passage.metadata = { position };
  }
  return passage;
}
