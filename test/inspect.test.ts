import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { compile } from '../src/compiler.js';
import { storyInspect } from '../src/inspect.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const FORMAT_DIR = join(FIXTURES_DIR, 'storyformats');

describe('storyInspect', () => {
  it('extracts passage names', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.passages).toContain('Start');
    expect(map.passages).toContain('Room');
    expect(map.passages).toContain('Secret Room');
    expect(map.passages).toContain('Ending');
    expect(map.passages).toContain('StoryData');
    expect(map.passages).toContain('StoryTitle');
  });

  it('separates story vs info passages', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.storyPassages).toContain('Start');
    expect(map.storyPassages).toContain('Room');
    expect(map.storyPassages).not.toContain('StoryData');
    expect(map.storyPassages).not.toContain('StoryTitle');

    expect(map.infoPassages).toContain('StoryData');
    expect(map.infoPassages).toContain('StoryTitle');
    expect(map.infoPassages).not.toContain('Start');
  });

  it('extracts all unique tags', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.tags).toContain('location');
    expect(map.tags).toContain('hidden');
    // Tags should be sorted
    expect(map.tags).toEqual([...map.tags].sort());
  });

  it('maps tags to passages and passages to tags', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.passagesByTag.get('location')).toContain('Room');
    expect(map.passagesByTag.get('location')).toContain('Secret Room');
    expect(map.passagesByTag.get('hidden')).toEqual(['Secret Room']);

    expect(map.tagsByPassage.get('Room')).toEqual(['location']);
    expect(map.tagsByPassage.get('Secret Room')).toEqual(['location', 'hidden']);
    expect(map.tagsByPassage.get('Start')).toEqual([]);
  });

  it('extracts [[wiki-style]] links', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    // [[Go to room->Room]]
    expect(map.links.get('Start')).toContain('Room');
    // [[Go back->Start]]
    expect(map.links.get('Room')).toContain('Start');
  });

  it('detects broken links', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'broken.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n[[Go->MissingRoom]]\n\n:: Room\nSafe passage',
        },
      ],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.brokenLinks).toHaveLength(1);
    expect(map.brokenLinks[0]).toEqual({ from: 'Start', to: 'MissingRoom' });
  });

  it('detects dead ends', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    // Secret Room and Ending have no outgoing links
    expect(map.deadEnds).toContain('Secret Room');
    expect(map.deadEnds).toContain('Ending');
    // Start and Room have links, so they're not dead ends
    expect(map.deadEnds).not.toContain('Start');
    expect(map.deadEnds).not.toContain('Room');
  });

  it('detects orphaned passages', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'multi-passage.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    // Secret Room and Ending are never linked to
    expect(map.orphans).toContain('Secret Room');
    expect(map.orphans).toContain('Ending');
    // Start is the start passage, so not an orphan
    expect(map.orphans).not.toContain('Start');
    // Room is linked from Start
    expect(map.orphans).not.toContain('Room');
  });

  it('reports the start passage', async () => {
    const result = await compile({
      sources: [join(FIXTURES_DIR, 'storydata.tw')],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.start).toBe('Begin');
  });

  it('parses pipe-style links [[display|target]]', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'pipe.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n[[Go somewhere|Room]]\n\n:: Room\nYou arrived.',
        },
      ],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.links.get('Start')).toContain('Room');
  });

  it('parses SugarCube <<goto>> macros', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'goto.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n<<goto "Redirect">>\n\n:: Redirect\nYou were redirected.',
        },
      ],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.links.get('Start')).toContain('Redirect');
  });

  it('parses SugarCube <<link>> macros with passage target', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'link.tw',
          content:
            ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\n<<link "Click me" "Target">><</link>>\n\n:: Target\nTarget reached.',
        },
      ],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.links.get('Start')).toContain('Target');
  });

  it('handles story with no links gracefully', async () => {
    const result = await compile({
      sources: [
        {
          filename: 'nolinks.tw',
          content: ':: StoryData\n{"ifid":"D674C58C-DEFA-4F70-B7A2-27742230C0FC"}\n\n:: Start\nJust text, no links.',
        },
      ],
      outputMode: 'json',
    });
    const map = storyInspect(result.story);

    expect(map.links.get('Start')).toEqual([]);
    expect(map.brokenLinks).toEqual([]);
    expect(map.deadEnds).toContain('Start');
  });
});
