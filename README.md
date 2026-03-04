# twee-ts

TypeScript reimplementation of [Tweego](https://www.motoslave.net/tweego/) — a command-line compiler for Twine/Twee interactive fiction projects.

Zero runtime dependencies. Node.js 22+.

**[Documentation](https://rohal12.github.io/twee-ts/)**

## Install

```sh
npm install @rohal12/twee-ts
```

## Quick Start

```sh
npx @rohal12/twee-ts --init               # scaffold a new project
npx @rohal12/twee-ts -o story.html src/   # compile
npx @rohal12/twee-ts -w -o story.html src/ # watch mode
```

Or with a config file (`twee-ts.config.json`):

```json
{
  "sources": ["src/"],
  "output": "story.html"
}
```

```sh
npx @rohal12/twee-ts
```

## Programmatic API

```typescript
import { compile } from '@rohal12/twee-ts';

const result = await compile({
  sources: ['src/'],
  tagAliases: { library: 'script' },
});
```

## Build Plugins

```typescript
// vite.config.ts
import { tweeTsPlugin } from '@rohal12/twee-ts/vite';

export default {
  plugins: [tweeTsPlugin({ sources: ['src/'] })],
};
```

Also available: `@rohal12/twee-ts/rollup`.

## Documentation

Full docs at **[rohal12.github.io/twee-ts](https://rohal12.github.io/twee-ts/)**:

- [Getting Started](https://rohal12.github.io/twee-ts/getting-started)
- [CLI Reference](https://rohal12.github.io/twee-ts/cli)
- [Configuration](https://rohal12.github.io/twee-ts/configuration)
- [Tag Aliases](https://rohal12.github.io/twee-ts/tag-aliases)
- [Programmatic API](https://rohal12.github.io/twee-ts/api)
- [Vite & Rollup Plugins](https://rohal12.github.io/twee-ts/plugins)
- [Story Formats](https://rohal12.github.io/twee-ts/story-formats)
- [Packaging Formats](https://rohal12.github.io/twee-ts/story-format-packages)

## Development

```sh
pnpm install
pnpm test            # run tests
pnpm run typecheck   # type-check
pnpm run build       # bundle
pnpm run docs:dev    # local docs dev server
pnpm run docs:build  # build docs for deployment
```

## License

This is free and unencumbered software released into the public domain. See [UNLICENSE](UNLICENSE).
