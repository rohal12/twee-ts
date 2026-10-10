# Differences from Tweego

twee-ts reads Twee and builds the story model as Tweego does, read from Tweego's Go source line by line: the same whitespace (Go's `unicode.IsSpace`, which counts U+0085 and not U+FEFF), the same escaping, the same rules for duplicate and special passages, the same StoryData decoding (keys match regardless of letter case, as Go's `encoding/json` matches them), the same Twee2 conversion and the same word count. This page lists every difference that is intended. Each one has a test in `test/tweego-differences.test.ts`, named after its number. Any other difference is a bug.

The first comparisons come from reading Tweego's source (`tweego/*.go`, `internal/tweelexer`, `internal/twee2compat`) and Go's standard library. The Twee2 conversion and the comment removal of the word count are also checked against Tweego's own regular expressions, run with Go's semantics. The output differences (D-20 to D-26) and the input differences (D-27 to D-29) come from comparing the output of twee-ts with that of a Tweego 2.1.1 binary in about 1,900 comparisons; a real project (CleanSlate) compiles to the same bytes apart from `creator`, `creator-version` and the `tags` attribute (D-22).

## Reading Twee

**D-1. Byte order marks before a header.** A byte order mark at the start of a line, directly before `::`, is removed, so a file made by joining Twee files (`cat a.tw b.tw`) keeps the headers of files saved with a byte order mark. Tweego removes only the byte order mark at the start of a file.

**D-2. Trailing blank lines with `trim: false`.** Without trimming, twee-ts still drops the blank lines at the end of a passage, as the Twee 3 specification requires (`:: A` then `x`, a blank line and `:: B` gives `x`). Tweego keeps the passage text exactly, line breaks included.

**D-3. A lone backslash at the end of a name.** Both drop it (`:: foo\` is the passage `foo`), but twee-ts warns, since the author most likely meant a backslash (`\\`).

**D-4. Passage metadata keys.** Besides `position` and `size`, twee-ts keeps every key whose value is a string (Tweego keeps only those two). A value of another type under another key is left out with a warning. As in Tweego, a `position` or `size` that is not a string makes the whole metadata block unusable, with a warning, and a key that differs from them only in letter case (`Position`) is read as them, here with a warning.

## StoryData and StorySettings

**D-5. Errors do not stop the build.** A StoryData passage that is not a JSON object, a field of the wrong type (`"format-version": 3`), or an IFID that is not valid stops Tweego. twee-ts reports an error for it (at the StoryData passage), leaves out what it cannot read (an invalid IFID is kept as written) and goes on, so all the problems are reported at once. The Twee 3 specification recommends a warning; an error is used because the story would otherwise be built with another format, start passage or IFID than the author wrote. The CLI then writes no output and exits with status 1; `compile()` returns the output with the errors.

**D-6. Keys Tweego accepts silently are reported.** A key read regardless of its letter case (`IFID`), a repeated key (the last one is used, as in Tweego) and an unknown key (left out of the rewritten StoryData passage, as in Tweego) each give a warning.

**D-7. The `tags` field.** twee-ts reads and writes the Twine 2 story tags (`"tags": "draft final"`); Tweego leaves the field out.

**D-8. Wrapped IFIDs.** An IFID written in the `UUID://…//` form is stored as the bare UUID; Tweego keeps the wrapper.

## Loading files

**D-9. Generated passage names do not replace passages.** Media, stylesheet, script and font files, and an imported Twine 2 story's stylesheet and script, get passage names made from file names. When such a name is taken, the file's passage gets the next free name (`style.css 2`) instead of replacing the passage or being replaced (see [Getting Started](./getting-started#passage-names-for-loaded-files)).

**D-10. Media and font files whose names start with a dot.** A media passage and a font family are named after the file up to its first dot, as in Tweego (`bg.night.png` gives `bg`). A name that starts with a dot keeps its leading dots and ends at the next one (`.hidden.png` gives `.hidden`); Tweego gives such a file an empty name.

**D-18. Script passages are joined with a statement boundary.** When a story has several scripts (`.js` files or `[script]` passages), twee-ts ends each but the last on a line of its own followed by `;`, in Twine 2 HTML, Twine 2 archive and JSON output. Tweego joins them as they are, so a source without a final semicolon followed by one that starts with `(`, `[`, a regular expression or a template literal runs together into one statement. A script is therefore a list of whole statements; one that continues in the next script passage is not supported. A single script and stylesheets are written as before.

**D-19. Story title and stylesheet imports.** HTML output needs a story name in every Twine 2 format: a missing `StoryTitle` passage (when the story has no name from an imported file) or an empty one is an error, since SugarCube cannot start without a name; Tweego checks only the missing passage. Stylesheets are joined as Tweego joins them, but twee-ts warns about an `@import` that follows another rule, which browsers ignore.

**D-27. Links and unsupported files.** A symbolic link to a file is read as the file it points to, whether it is found in a source folder or named as a source; Tweego skips it either way, without a word. (A link to a directory found in a source folder is not followed by either.) A source that is named on the command line (or in `sources`) and has a type twee-ts does not load is a warning; Tweego ignores it silently.

**D-28. Windows-1252 bytes without a letter.** A file that is not valid UTF-8 is read as Windows-1252 in both, but the five bytes the encoding leaves undefined (0x81, 0x8D, 0x8F, 0x90 and 0x9D) become U+0081, U+008D, U+008F, U+0090 and U+009D in twee-ts (the WHATWG decoder, as browsers read the encoding), and U+FFFD in Tweego (Go's `charmap`).

## Twee output

**D-11. The written Twee is checked.** Each passage is read back with the Twee reader; twee-ts warns about each passage that would read back differently and says why (a text line that starts with `::`, a name with surrounding white space or a line break, a tag with white space, and in Twee 1 the characters it cannot escape). In stylesheet and script passages, a text line that would read as a header is indented by one space. Twee 1 output warns once that it leaves out passage metadata. Tweego writes the same Twee without warnings.

**D-12. StoryData is written from the story.** The StoryData passage records what the compile options changed (the start passage, test mode) and a generated IFID. Tweego writes it as it rewrote it when loading, without the options' changes.

**D-17. Line endings.** Twee output uses LF line endings on every operating system, so a build gives the same bytes everywhere; Tweego writes CRLF on Windows. Both read either.

**D-20. The StoryData JSON.** The StoryData passage that Twee output and a decompile write differs from Tweego's in four details, none of which changes what the passage means:

- `"zoom"` is left out when it is the default, 1. Tweego always writes `"zoom": 1`; both read a passage with or without it.
- The keys of `tag-colors` keep the order of the StoryData that was read (and `options` the order of the story). Tweego sorts the tag names, and writes the options in an order that changes from run to run.
- `<`, `>`, `&` and U+2028 in a string are written as they are. Go's JSON encoder writes them as `\u003c`, `\u003e`, `\u0026` and `\u2028`.
- A `\ud800` escape (a lone surrogate) in a string is read as a lone surrogate. Go reads it as U+FFFD. HTML output reports a tag color name that holds one as an error, since HTML cannot carry it.

## Twine 2 output

**D-21. Attribute values.** Tweego writes the names, tags and positions of passages with Go's `%q`, which doubles a backslash and writes the characters Go does not print as escape text: a tab as `\t`, and U+00A0, U+0085, U+00AD, U+200B, U+2028, U+3000 and U+FEFF as `\u00a0` and so on. Those are not HTML escapes, so Twine 2 reads the doubled backslash and the escape text as they stand (a passage `A\b` comes back as `A\\b`). twee-ts writes the characters themselves, so the names are what the author wrote. The escaping of `<`, `>` and `&` differs too: a passage `name` has `&lt;` and `&gt;` in twee-ts and the raw characters in Tweego, `tags` keep `<` and `>` in both, and the name of a `<tw-tag>` has `&amp;` in twee-ts and no escapes in Tweego. Every HTML parser reads the two forms as the same text.

**D-22. Story attributes.** The `<tw-storydata>` element has `creator="Twee-ts"` and the twee-ts version (Tweego: `Tweego` and its version), and always a `tags` attribute, empty when the story has no story tags (Tweego has no story tags, D-7, and writes no attribute). The `<tw-tag>` elements are in the order of the StoryData; Tweego writes them in an order that changes from run to run.

**D-23. The format of a Twine 2 archive.** `-a` (and `outputMode: 'twine2-archive'`) writes `format` and `format-version` as StoryData gives them, and writes them empty when it names none; `-f` and `formatId` are not used, since an archive needs no story format. Tweego writes the format it finds: the one `-f` or StoryData names, or the default, at the greatest installed version, so with `"format-version": "2.30.0"` in StoryData it writes the greatest SugarCube 2 it has. Twine 2 opens an archive whose `format` is empty with its default story format; name the format in StoryData to keep it.

## Twine 1 output

**D-24. Twine 1 HTML and archives.** Every tiddler has `created="YYYYMMDDHHMM"` and `modifier="twee"` attributes, as the Twine 1 HTML output specification has them; Tweego writes neither. The store area of an archive (`--archive-twine1`) has no `hidden` attribute, where Tweego's has. In HTML output, the `"TIME"` placeholder becomes `Built on ` and the UTC time (`Sat, 10 Oct 2026 16:16:11 GMT`), so that `SOURCE_DATE_EPOCH` gives the same bytes everywhere; Tweego writes its local time in the RFC 1123Z form (`Sun, 11 Oct 2026 00:16:11 +0800`). Tweego also replaces the Twine byline of the format's header (`<a href="http://twinery.org/">Twine</a>`) with a link to Tweego; twee-ts leaves the header's byline as it is.

**D-25. End tags in code.** Script, stylesheet and module content has `</script>` and `</style>` written as `<\/script>` and `<\/style>`, which a script and a stylesheet read as the same text. Tweego writes them as they are, so a script that holds the string `"</script>"` ends its element there and breaks the page.

## Diagnostics

**D-13. Locations.** Diagnostics about a passage carry its file and line, and the warning about a duplicate passage also names the file and line of the passage it replaces.

**D-26. Statistics.** The word count of `-l` is the word count of the story that is built. After a replaced duplicate passage, Tweego still counts the words of the first passage (`:: Dup` with `first one two three` and then `:: Dup` with `second` gives a count of 4 in Tweego and 2 in twee-ts). The layout of the report differs too: twee-ts writes `Statistics:` with `Passages`, `Words` and `Files`, and `--log-files` writes `Files: a, b` and `External files: …`; Tweego writes `Processed files (in order)`, `Total> Passages: N` and `Story> Passages: N, Words: N`. All of it goes to standard error in twee-ts. A script that parses Tweego's report has to be changed.

## Reading Twine 2 HTML

**D-14. Passages named StoryData or StoryTitle.** In Twine 2 HTML the story metadata and name are the `tw-storydata` attributes, which Twine 2 and the story formats read; a passage named StoryData or StoryTitle is an ordinary passage to them. twee-ts keeps the attributes and gives such a passage the next free name (`StoryData 2`), with a warning, unless it is a StoryTitle that holds the story name. Tweego reads the passage as the special passage, so a StoryData passage overrides the IFID, format and start passage the attributes give.

**D-15. Numbers in attributes.** `startnode` and `pid` are read as Go's `strconv.Atoi` reads them (an optional sign and decimal digits), up to 2^53 − 1. `zoom` must be a finite decimal number (`0.6`, `.5`, `6e-1`); Go's `ParseFloat` also accepts `Inf`, `NaN`, hexadecimal and underscores, which twee-ts reports as it reports any value it cannot read. A `startnode` that no passage has as its `pid` is a warning; Tweego leaves the story without a start passage silently.

**D-29. HTML parsing.** twee-ts reads Twine 2 HTML with a parser that follows the HTML Standard (parse5) and takes all the text of a `<tw-passagedata>` element, where Tweego takes the text of its first child node only. A comment or a CDATA section (which HTML reads as a comment) in a passage ends Tweego's text: `a<!-- c -->b<![CDATA[x]]>z` is `a` in Tweego and `abz` in twee-ts. A story element inside `<template>` is inert content for a browser, and twee-ts skips it; Tweego reads it, so a file that holds a decoy story in a template before the real one gives the decoy in Tweego and the real story in twee-ts.

## Twee2 conversion

**D-16. Twee2 positions are escaped.** Converting a Twee2 header (`--twee2-compat`, `.tw2` files), twee-ts writes the position as a JSON string, so a `"`, `\` or control character in `<…>` stays part of the position. Tweego puts the text in as it is, so `:: A <1","size":"9,9>` gets a `size` key and `:: A <1\>` metadata that is not valid JSON.
