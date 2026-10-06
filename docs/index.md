---
layout: home

hero:
  name: twee-ts
  text: TypeScript Twee-to-HTML Compiler
  tagline: A complete reimplementation of Tweego. Zero runtime dependencies. Node.js 22.12+.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: CLI Reference
      link: /cli
    - theme: alt
      text: GitHub
      link: https://github.com/rohal12/twee-ts

features:
  - title: Drop-in Tweego Replacement
    details: Reads the same .twee, .tw, .css, .js, font, and media files. Respects TWEEGO_PATH. Equivalent output, with every intended difference listed.
  - title: Zero Runtime Dependencies
    details: Nothing to install besides twee-ts itself; the HTML and JavaScript parsers it uses (parse5, acorn) are bundled. Runs on Node.js 22.12+.
  - title: Programmatic API
    details: Use compile(), compileToFile(), and watch() directly from your TypeScript or JavaScript code.
  - title: Build Tool Plugins
    details: Vite and Rollup plugins that build the story; Vite's dev server reloads it when a source changes.
  - title: Remote Format Fetching
    details: Story formats not found locally are downloaded from your format URLs and indices or the Story Formats Archive, checked and cached.
  - title: Tag Aliases
    details: Map custom tag names like "library" or "theme" to built-in special tags like "script" and "stylesheet".
---

## Quick Example

```sh
# Install
npm install @rohal12/twee-ts

# Initialize a project
npx @rohal12/twee-ts --init

# Compile
npx @rohal12/twee-ts -o story.html src/
```

Or use the programmatic API:

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/'],
  tagAliases: { library: 'script' },
});
console.log(result.diagnostics);
```
