# Differences from Tweego

twee-ts reads Twee and builds the story model as Tweego does, read from Tweego's Go source line by line: the same whitespace (Go's `unicode.IsSpace`, which counts U+0085 and not U+FEFF), the same escaping, the same rules for duplicate and special passages, the same StoryData decoding (keys match regardless of letter case, as Go's `encoding/json` matches them), the same Twee2 conversion and the same word count. This page lists every difference that is intended. Each one has a test in `test/tweego-differences.test.ts`, named after its number. Any other difference is a bug.

Go was not available when this list was made, so the comparisons come from reading Tweego's source (`tweego/*.go`, `internal/tweelexer`, `internal/twee2compat`) and Go's standard library. The Twee2 conversion and the comment removal of the word count are also checked against Tweego's own regular expressions, run with Go's semantics.

## Reading Twee

**D-1. Byte order marks before a header.** A byte order mark at the start of a line, directly before `::`, is removed, so a file made by joining Twee files (`cat a.tw b.tw`) keeps the headers of files saved with a byte order mark. Tweego removes only the byte order mark at the start of a file.

**D-2. Trailing blank lines with `trim: false`.** Without trimming, twee-ts still drops the blank lines at the end of a passage, as the Twee 3 specification requires (`:: A` then `x`, a blank line and `:: B` gives `x`). Tweego keeps the passage text exactly, line breaks included.

**D-3. A lone backslash at the end of a name.** Both drop it (`:: foo\` is the passage `foo`), but twee-ts warns, since the author most likely meant a backslash (`\\`).

**D-4. Passage metadata keys.** Besides `position` and `size`, twee-ts keeps every key whose value is a string (Tweego keeps only those two). A value of another type under another key is left out with a warning. As in Tweego, a `position` or `size` that is not a string makes the whole metadata block unusable, with a warning, and a key that differs from them only in letter case (`Position`) is read as them, here with a warning.

## StoryData and StorySettings

**D-5. Errors do not stop the build.** A StoryData passage that is not a JSON object, or a field of the wrong type (`"format-version": 3`), stops Tweego. twee-ts reports an error for it (at the StoryData passage), leaves out what it cannot read and goes on, so all the problems are reported at once. The Twee 3 specification recommends a warning; an error is used because the story would otherwise be built with another format, start passage or IFID than the author wrote. The CLI exits with status 1.

**D-6. Keys Tweego accepts silently are reported.** A key read regardless of its letter case (`IFID`), a repeated key (the last one is used, as in Tweego) and an unknown key (left out of the rewritten StoryData passage, as in Tweego) each give a warning.

**D-7. The `tags` field.** twee-ts reads and writes the Twine 2 story tags (`"tags": "draft final"`); Tweego leaves the field out.

**D-8. Wrapped IFIDs.** An IFID written in the `UUID://…//` form is stored as the bare UUID; Tweego keeps the wrapper.

## Loading files

**D-9. Generated passage names do not replace passages.** Media, stylesheet, script and font files, and an imported Twine 2 story's stylesheet and script, get passage names made from file names. When such a name is taken, the file's passage gets the next free name (`style.css 2`) instead of replacing the passage or being replaced (see [Getting Started](./getting-started#passage-names-for-loaded-files)).

**D-10. Media and font files whose names start with a dot.** A media passage and a font family are named after the file up to its first dot, as in Tweego (`bg.night.png` gives `bg`). A name that starts with a dot keeps its leading dots and ends at the next one (`.hidden.png` gives `.hidden`); Tweego gives such a file an empty name.

## Twee output

**D-11. The written Twee is checked.** Each passage is read back with the Twee reader; twee-ts warns about each passage that would read back differently and says why (a text line that starts with `::`, a name with surrounding white space or a line break, a tag with white space, and in Twee 1 the characters it cannot escape). In stylesheet and script passages, a text line that would read as a header is indented by one space. Twee 1 output warns once that it leaves out passage metadata. Tweego writes the same Twee without warnings.

**D-12. StoryData is written from the story.** The StoryData passage records what the compile options changed (the start passage, test mode) and a generated IFID. Tweego writes the passage as loaded.

## Diagnostics

**D-13. Locations.** Diagnostics about a passage carry its file and line, and the warning about a duplicate passage also names the file and line of the passage it replaces.
