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

  describe('SugarCube macro arguments', () => {
    const IFID = 'D674C58C-DEFA-4F70-B7A2-27742230C0FC';

    /** Compiles `Start` with the given text, plus any other passages, and inspects the story. */
    async function inspectStart(startText: string, otherPassages: readonly string[] = []) {
      const others = otherPassages.map((name) => `:: ${name}\nText.`).join('\n\n');
      const result = await compile({
        sources: [
          {
            filename: 'macros.tw',
            content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\n${startText}\n\n${others}`,
          },
        ],
        outputMode: 'json',
      });
      return storyInspect(result.story);
    }

    async function startLinks(startText: string): Promise<string[] | undefined> {
      return (await inspectStart(startText)).links.get('Start');
    }

    it('reads <<link>> when the label has an apostrophe', async () => {
      expect(await startLinks(`<<link "You're late" "Next">><</link>>`)).toEqual(['Next']);
    });

    it('reads <<link>> when the passage name has an apostrophe', async () => {
      expect(await startLinks(`<<link "Go" "Don't talk yet">><</link>>`)).toEqual(["Don't talk yet"]);
    });

    it('reads <<link>> when both arguments have apostrophes', async () => {
      expect(await startLinks(`<<link "Tell him it's none of his business" "It's his business">><</link>>`)).toEqual([
        "It's his business",
      ]);
    });

    it('reads <<link>> when a single-quoted label has double quotes', async () => {
      expect(await startLinks(`<<link 'Say "no"' "Refuse">><</link>>`)).toEqual(['Refuse']);
    });

    it('reads <<link>> when a single-quoted passage name has double quotes', async () => {
      expect(await startLinks(`<<link "Go" 'The "real" ending'>><</link>>`)).toEqual(['The "real" ending']);
    });

    it('reads backslash-escaped quotes the way SugarCube does', async () => {
      expect(await startLinks(`<<link "Say \\"no\\"" "Refuse">><</link>>`)).toEqual(['Refuse']);
      expect(await startLinks(`<<link 'Go' 'Mary\\'s room'>><</link>>`)).toEqual(["Mary's room"]);
      expect(await startLinks(`<<link "Go" "The \\"real\\" ending">><</link>>`)).toEqual(['The "real" ending']);
    });

    it('decodes other escapes in a passage name as JavaScript does', async () => {
      expect(await startLinks(`<<link "Go" "\\u0041 room">><</link>>`)).toEqual(['A room']);
      expect(await startLinks(`<<link "Go" "\\x41 room">><</link>>`)).toEqual(['A room']);
      expect(await startLinks(`<<link "Go" "back\\\\slash">><</link>>`)).toEqual(['back\\slash']);
      expect(await startLinks(`<<link "Go" "\\q">><</link>>`)).toEqual(['q']);
    });

    it('reports a <<link>> to a missing passage when the label has an apostrophe', async () => {
      const map = await inspectStart(`<<link "You're late" "Nowhere">><</link>>`);
      expect(map.brokenLinks).toEqual([{ from: 'Start', to: 'Nowhere' }]);
    });

    it('does not report a <<link>> whose passage exists and whose arguments have quotes', async () => {
      const map = await inspectStart(`<<link "You're late" "Don't talk yet">><</link>>`, ["Don't talk yet"]);
      expect(map.brokenLinks).toEqual([]);
      expect(map.orphans).not.toContain("Don't talk yet");
      expect(map.deadEnds).not.toContain('Start');
    });

    it('reads <<link>> with an empty label', async () => {
      expect(await startLinks(`<<link "" "Next">><</link>>`)).toEqual(['Next']);
      expect(await startLinks(`<<link '' "Next">><</link>>`)).toEqual(['Next']);
    });

    it('reports a <<link>> to an empty passage name as broken', async () => {
      const map = await inspectStart(`<<link "Go" "">><</link>>`);
      expect(map.brokenLinks).toEqual([{ from: 'Start', to: '' }]);
    });

    it('reads <<link>> when a quoted argument contains >>', async () => {
      expect(await startLinks(`<<link "Next >>" "Next">><</link>>`)).toEqual(['Next']);
      expect(await startLinks(`<<link 'a >> b' "Room">><</link>>`)).toEqual(['Room']);
    });

    it('reads <<link>> arguments split across lines or written without spaces', async () => {
      expect(await startLinks(`<<link "Go"\n  "Room">><</link>>`)).toEqual(['Room']);
      expect(await startLinks(`<<link"Go""Room">><</link>>`)).toEqual(['Room']);
    });

    it('reads a bare word or number as the passage name, as SugarCube does', async () => {
      expect(await startLinks(`<<link "Go" Room>><</link>>`)).toEqual(['Room']);
      expect(await startLinks(`<<link "Go" 42>><</link>>`)).toEqual(['42']);
    });

    it('takes no passage name from the one-argument form', async () => {
      const map = await inspectStart(`<<link "Don't">><<set $x to 1>><</link>> and "Other"`);
      expect(map.links.get('Start')).toEqual([]);
      expect(map.deadEnds).toContain('Start');
    });

    it('reads link markup in <<link>> and ignores a second argument after it', async () => {
      expect(await startLinks(`<<link [[Go|Room]]>><</link>>`)).toEqual(['Room']);
      expect(await startLinks(`<<link [[Don't go|Room]] "Other">><</link>>`)).toEqual(['Room']);
    });

    it('takes no passage name from variables, expressions, null or booleans', async () => {
      const map = await inspectStart(
        [
          `<<link "Go" $next>><</link>>`,
          `<<link "Go" _next>><</link>>`,
          '<<link "Go" `"Ro" + "om"`>><</link>>',
          `<<link "Go" setup.next>><</link>>`,
          `<<link "Go" null>><</link>>`,
          `<<link "Go" true>><</link>>`,
          `<<goto $dest>>`,
        ].join('\n'),
      );
      expect(map.links.get('Start')).toEqual([]);
      expect(map.brokenLinks).toEqual([]);
    });

    it('takes no passage name from arguments SugarCube cannot parse', async () => {
      // An unterminated string and a strict-mode octal escape both make SugarCube reject the macro.
      expect(await startLinks(`<<link "Go" "Room>><</link>>`)).toEqual([]);
      expect(await startLinks(`<<link "Go" "Room\\1">><</link>>`)).toEqual([]);
    });

    it('ignores macros whose names only start with link or goto', async () => {
      expect(await startLinks(`<<linkreplace "Don't">>x<</linkreplace>><<link-x "a" "B">><<gotox "C">>`)).toEqual([]);
    });

    it('reads macros inside the body of a <<link>>', async () => {
      expect(await startLinks(`<<link "Open">><<goto "Don't talk yet">><</link>>`)).toEqual(["Don't talk yet"]);
    });

    it('reads <<goto>> when the passage name has quotes', async () => {
      expect(await startLinks(`<<goto "Don't talk yet">>`)).toEqual(["Don't talk yet"]);
      expect(await startLinks(`<<goto 'Say "no"'>>`)).toEqual(['Say "no"']);
      expect(await startLinks(`<<goto "Say \\"no\\"">>`)).toEqual(['Say "no"']);
    });

    it('reads <<goto>> with link markup', async () => {
      expect(await startLinks(`<<goto [[Room]]>>`)).toEqual(['Room']);
    });

    it('takes no passage name from a null label, and reports <<goto "">> as broken', async () => {
      expect(await startLinks(`<<link null "Room">><</link>>`)).toEqual([]);
      const map = await inspectStart(`<<goto "">>`);
      expect(map.brokenLinks).toEqual([{ from: 'Start', to: '' }]);
    });

    it('reads calls inside the quoted strings of other macros', async () => {
      expect(
        await startLinks(`<<set _out to '<<link "Hooters" "Downtown">><<popUp "Open 8am">><</link>>'>>\n_out`),
      ).toEqual(['Downtown']);
      expect(await startLinks(`<<set _out to '<<link "Kelly\\'s Pub" "Pub">><</link>>'>>`)).toEqual(['Pub']);
      expect(await startLinks(`<<run $.wiki('<<goto "Kitchen">>')>>`)).toEqual(['Kitchen']);
      expect(await startLinks(`<<set _a to "<<set _b to '<<goto \\"Deep\\">>'>>">>`)).toEqual(['Deep']);
      expect(await startLinks('<<run $.wiki(`<<goto "Hall">>`)>>')).toEqual(['Hall']);
    });

    it('takes no passage name from a call put together from pieces', async () => {
      const map = await inspectStart(
        [
          `<<set _out to '<<goto "' + $target + '">>'>>`,
          `<<run $.wiki('<<link "' + _label + '" "' + _passage + '">><</link>>')>>`,
          '<<run $.wiki(`<<goto ${_dest}>>`)>>',
        ].join('\n'),
      );
      expect(map.links.get('Start')).toEqual([]);
      expect(map.brokenLinks).toEqual([]);
    });

    it('reads a <<script>> body as JavaScript', async () => {
      const map = await inspectStart(
        [
          '<<script>>',
          `  Dialog.wiki('<<textbox "$name" "">><<button "Done">><<goto "Room">><</button>>');`,
          `  $.wiki('<<goto "' + target + '">>');`,
          `  // <<goto "Commented out">>`,
          '<</script>>',
          `<<goto "After">>`,
        ].join('\n'),
        ['Room', 'After'],
      );
      expect(map.links.get('Start')).toEqual(['Room', 'After']);
      expect(map.brokenLinks).toEqual([]);
    });

    it('reads a script passage as JavaScript', async () => {
      const result = await compile({
        sources: [
          {
            filename: 'script.tw',
            content: [
              `:: StoryData\n{"ifid":"${IFID}"}`,
              ':: Start\nText.',
              ':: Room\nText.',
              [
                ':: Story JavaScript [script]',
                `Macro.add('go', { handler() { $(this.output).wiki('<<link "' + this.args[0] + '" "' + this.args[1] + '">><</link>>'); } });`,
                '$(document).one(":passagerender", () => $.wiki(`<<goto ${State.variables.next}>>`));',
                `const quote = /'/g; Dialog.wiki('<<link "Go" "Room">><</link>>'); // <<goto "Nowhere">>`,
              ].join('\n'),
            ].join('\n\n'),
          },
        ],
        outputMode: 'json',
      });
      const map = storyInspect(result.story);
      expect(map.links.get('Story JavaScript')).toEqual(['Room']);
      expect(map.brokenLinks).toEqual([]);
    });

    it('reads a call after an unclosed <<word in text SugarCube reads as something else', async () => {
      // The comment is skipped, or, in other markup, the <<goto inside the stray tag is still read.
      for (const before of [
        '/* TODO <<fix this */',
        '/% <<old %/',
        '<!-- <<old stuff -->',
        '<nowiki><<b</nowiki>',
        '{{{<<code}}}',
        '<html><<b</html>',
        '<style>p::before { content: "<<"; }</style>',
      ]) {
        expect(await startLinks(`${before} <<goto "Room">>`), before).toEqual(['Room']);
      }
      expect(await startLinks(`[[<<Back|Prev]] <<link "Go" "Room">><</link>>`)).toEqual(['Prev', 'Room']);
      expect(await startLinks(`https://example.com/<<x <<goto "Room">>`)).toEqual(['Room']);
    });

    it('reads no call in commented-out code, which SugarCube never runs', async () => {
      const map = await inspectStart(
        [
          '<<link "Hug" Hug>><</link>>',
          '/*',
          '<<if $close>>',
          '  <<link "Ask to make out" Makeout>><</link>>',
          '<</if>>',
          '*/',
          '/% <<goto "Old">> %/ <!-- <<goto "Older">> -->',
        ].join('\n'),
        ['Hug'],
      );
      expect(map.links.get('Start')).toEqual(['Hug']);
      expect(map.brokenLinks).toEqual([]);
    });

    it('reads calls in an <html> block that holds a closing tag, as SugarCube runs them', async () => {
      expect(
        await startLinks(`<<if true>><html><div><</if>>\n<<goto "Between">>\n<<if true>></div></html><</if>>`),
      ).toEqual(['Between']);
    });

    it('reads a template literal with a substitution in its label', async () => {
      expect(await startLinks('<<print `<<link "${_label}" "Room">><</link>>`>>')).toEqual(['Room']);
      expect(await startLinks('<<script>>$(output).wiki(`<<link "${name}" "Room">><</link>>`);<</script>>')).toEqual([
        'Room',
      ]);
      expect(await startLinks('<<print `<<goto "${_dest}">>`>>')).toEqual([]);
    });

    it('reads a backquoted argument as an expression, except where arguments are JavaScript', async () => {
      const map = await inspectStart(`<<link \`"<<goto '" + _dest + "'>>"\`>><</link>>`);
      expect(map.links.get('Start')).toEqual([]);
      expect(map.brokenLinks).toEqual([]);
      expect(await startLinks('<<link `"<<goto \'Room\'>>"`>><</link>>')).toEqual(['Room']);
      expect(await startLinks('<<print `<<goto "Hall">>`>>')).toEqual(['Hall']);
    });

    it('finds the end of a <<script>> body as SugarCube does', async () => {
      expect(await startLinks(`<<script>>$.wiki('<<goto "A">>')<<endscript>><<goto "B">>`)).toEqual(['A', 'B']);
      // The body ends at the <</script>> that matches, counting the nested opener in the comment.
      expect(
        await startLinks(`<<script>>/* <<script>> */ $.wiki('<<goto "A">>'); /* <</script>> */<</script>><<goto "B">>`),
      ).toEqual(['A', 'B']);
      // Unclosed: SugarCube reports the error and reads the rest as markup.
      expect(await startLinks(`<<script>>$.wiki('x'); <<goto "A">>`)).toEqual(['A']);
      expect(await startLinks(`<script>$.wiki('<<goto "A">>'); /* <<goto "' + b + '">> */</script>`)).toEqual(['A']);
    });

    it('reads a <script> element inside an <html> block as JavaScript', async () => {
      const map = await inspectStart(
        `<html><div id="h"></div><script>SugarCube.Wikifier.wikifyEval('<<goto "FromScript">>'); $.wiki('<<goto "' + x + '">>');</script></html>`,
      );
      expect(map.links.get('Start')).toEqual(['FromScript']);
      expect(map.brokenLinks).toEqual([{ from: 'Start', to: 'FromScript' }]);
    });

    it('reads the arguments of macros SugarCube does not split as JavaScript', async () => {
      // A template literal is a value there, but an expression in the macros that split their arguments.
      for (const tag of ['<<print', '<<if', '<<elseif', '<<switch', '<<set _x to', '<<optionsfrom']) {
        expect(await startLinks(`${tag} \`<<link "\${x}" "Room">>\` >>`), tag).toEqual(['Room']);
      }
      for (const tag of ['<<case', '<<option', '<<cycle', '<<link "Go"']) {
        expect(await startLinks(`${tag} \`<<link "\${x}" "Room">>\` >>`), tag).toEqual([]);
      }
    });

    it('takes no passage name where a substitution may change which argument is the passage', async () => {
      const map = await inspectStart(
        [
          '<<print `<<link${_t} "Go">><</link>>`>>',
          '<<print `<<link ${_label} "Room">><</link>>`>>',
          '<<print `<<goto ${_d}>>`>>',
        ].join('\n'),
      );
      expect(map.links.get('Start')).toEqual([]);
      expect(await startLinks('<<print `<<link "${_label}" "Room">><</link>>`>>')).toEqual(['Room']);
    });

    it('reads strings nested ten levels deep, and no deeper', async () => {
      let call = '<<goto "Deep">>';
      for (let level = 0; level < 10; level++) {
        call = `<<print ${JSON.stringify(call)}>>`;
      }
      expect(await startLinks(call)).toEqual(['Deep']);
      expect(await startLinks(`<<print ${JSON.stringify(call)}>>`)).toEqual([]);
    });

    it('does not take the <script> inside <<script>> for an element', async () => {
      // Unclosed: SugarCube reports the error and reads the rest as markup.
      expect(await startLinks(`<<script>><<goto "G1">>//</script>`)).toEqual(['G1']);
      expect(await startLinks(`<<script>>$.wiki('<<goto "A">>')<</script>><<goto "B">></script>`)).toEqual(['A', 'B']);
    });

    it('reports no passage for a call built in a <<script>> body after a comment', async () => {
      const map = await inspectStart(
        `<<set _t to "Y">><!-- <<x " --><<script>>$(output).wiki('<<goto "' + State.temporary.t + '">>');<</script>>" >>`,
      );
      expect(map.brokenLinks).toEqual([]);
    });

    it('reads the calls after a stray <<word in a comment, whatever follows', async () => {
      const text = [
        '<!-- TODO: <<linkreplace for the shop -->',
        "You're in the hall.",
        '<<link "Go to the shop" "Shop">><</link>>',
        "You don't see anyone.",
        '<<link "Leave" "Street">><</link>>',
      ];
      expect(await startLinks(text.join('\n'))).toEqual(['Shop', 'Street']);
      expect(
        await startLinks(`/* <<fix it's broken */\n<<goto "Room">>\nLater text it's here.\n<<set $x to 1>>`),
      ).toEqual(['Room']);
      expect(await startLinks(`/* <<x */ <<set _a to '<<goto "B">>'>><<print _a>>`)).toEqual(['B']);
      expect(await startLinks(`<!-- <<x --> <<set _a to '<<goto "B">>'>><<print _a>>`)).toEqual(['B']);
    });

    it('reads a <<link>> whose label is a variable', async () => {
      expect(await startLinks(`<<link $label "Room">><</link>>`)).toEqual(['Room']);
      expect(await startLinks(`<<link _tmpImg "listItems">><</link>>`)).toEqual(['listItems']);
    });

    it('reads a <<script "TwineScript">> body as JavaScript', async () => {
      expect(
        await startLinks(`<<script "TwineScript">>$.wiki('<<goto "A">>'); $.wiki('<<goto "' + _b + '">>')<</script>>`),
      ).toEqual(['A']);
    });

    it('reads a call after a stray <<-, <<=, <<if or <<set in link markup or verbatim text', async () => {
      expect(await startLinks('[[<<-- Back|Prev]]\n<<link "Go on" "Room">><</link>>')).toEqual(['Prev', 'Room']);
      expect(await startLinks('[[<<== Back|Prev]] <<goto "Room">>')).toEqual(['Prev', 'Room']);
      // Text between the stray tag and the call is read as it would be in a tag's arguments, not
      // as JavaScript: italics or a URL there hide nothing when no later >> ends the tag.
      expect(await startLinks('[[<<- Back|Prev]] //Whispers// <<goto "R">>')).toEqual(['Prev', 'R']);
      expect(await startLinks('[[<<- Back|Prev]] See http://example.com <<link "Next" "N">><</link>>')).toEqual([
        'Prev',
        'N',
      ]);
      expect(await startLinks('{{{<<if}}} <<goto "Room">>')).toEqual(['Room']);
      expect(await startLinks('<nowiki><<set</nowiki> <<goto "Room">>')).toEqual(['Room']);
    });

    it('joins the lines of a passage tagged nobr, as SugarCube does', async () => {
      const result = await compile({
        sources: [
          {
            filename: 'nobr.tw',
            content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start [nobr]\n<<link "Go back to the\n  kitchen" "Kitchen">><</link>>\n\n:: Kitchen\nText.`,
          },
        ],
        outputMode: 'json',
      });
      expect(storyInspect(result.story).links.get('Start')).toEqual(['Kitchen']);
      // Without the tag, SugarCube rejects a quoted argument that spans lines.
      expect(await startLinks(`<<link "Go back to the\n  kitchen" "Kitchen">><</link>>`)).toEqual([]);
    });

    it('joins a nobr passage with a long run of line breaks quickly', async () => {
      const result = await compile({
        sources: [
          {
            filename: 'lines.tw',
            content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start [nobr]\n[[Go to\nKitchen]]${'\n'.repeat(200_000)}<<goto "Kitchen">>\n\n:: Kitchen\nText.`,
          },
        ],
        outputMode: 'json',
      });
      // Joined as SugarCube joins it, the link markup names "Go to Kitchen".
      expect(storyInspect(result.story).links.get('Start')).toEqual(['Go to Kitchen', 'Kitchen']);
    });

    it('keeps the lines of passages SugarCube runs from their raw text, even when tagged nobr', async () => {
      const body = `<<script>>\n// jump now\n$.wiki('<<goto "Late">>');\n<</script>>`;
      for (const header of [':: StoryInit [nobr]', ':: PassageDone [nobr]', ':: Setup [init nobr]']) {
        const result = await compile({
          sources: [
            {
              filename: 'raw.tw',
              content: `:: StoryData\n{"ifid":"${IFID}"}\n\n:: Start\nText.\n\n${header}\n${body}\n\n:: Late\nText.`,
            },
          ],
          outputMode: 'json',
        });
        const name = header.slice(3).split(' ')[0] ?? '';
        expect(storyInspect(result.story).links.get(name), header).toEqual(['Late']);
      }
    });

    it('tells italics from a comment, and reads comments and elements as SugarCube does', async () => {
      expect(await startLinks('//*note:// <<goto "A">> */')).toEqual(['A']);
      // A comment doesn't cross U+2028 or U+2029: these aren't closed, and the calls in them run.
      expect(await startLinks('/* <<goto "A">> \u2028 */')).toEqual(['A']);
      expect(await startLinks('<!-- <<goto "B">> \u2029 -->')).toEqual(['B']);
      // An unclosed <script> element: the text after its opener is markup.
      expect(await startLinks('<script title="/*">\n<<goto "A">> */')).toEqual(['A']);
    });

    it('ends a <<script>> body correctly after a stray opener in a comment runs over it', async () => {
      // The body runs from the first <<script>> to the second <</script>>, counting the nested
      // opener; SugarCube reads it as JavaScript, so the <<goto "A">> inside it never runs.
      expect(
        await startLinks('/* <<x " */<<script>><<script>>" >> <</script>><<goto "A">><</script>><<goto "B">>'),
      ).toEqual(['B']);
    });

    it('stays fast with many <<script>> openers', async () => {
      const map = await inspectStart('<<script>>'.repeat(40000) + '<</script>>');
      expect(map.links.get('Start')).toEqual([]);
    });
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
