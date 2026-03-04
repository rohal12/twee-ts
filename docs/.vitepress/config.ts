import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'twee-ts',
  description: 'TypeScript Twee-to-HTML compiler — a reimplementation of Tweego',

  // Deploy to GitHub Pages at https://<user>.github.io/twee-ts/
  base: '/twee-ts/',

  head: [['meta', { name: 'theme-color', content: '#6366f1' }]],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'API', link: '/api' },
      { text: 'Config', link: '/configuration' },
      {
        text: 'npm',
        link: 'https://www.npmjs.com/package/@rohal12/twee-ts',
      },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is twee-ts?', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
        ],
      },
      {
        text: 'Usage',
        items: [
          { text: 'CLI Reference', link: '/cli' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Tag Aliases', link: '/tag-aliases' },
          { text: 'Output Modes', link: '/output-modes' },
        ],
      },
      {
        text: 'Integration',
        items: [
          { text: 'Programmatic API', link: '/api' },
          { text: 'Vite & Rollup Plugins', link: '/plugins' },
        ],
      },
      {
        text: 'Story Formats',
        items: [
          { text: 'Format Discovery', link: '/story-formats' },
          { text: 'Packaging Formats', link: '/story-format-packages' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/rohal12/twee-ts' }],

    footer: {
      message: 'Released under the Unlicense.',
      copyright: 'Public domain.',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/rohal12/twee-ts/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
