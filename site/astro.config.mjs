import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://tablewalk.dev',
  output: 'static',
  /* Addresses tablewalk.dev served while it was the framework's combined site, and the ones mistriwork.dev still
     sends readers to: each lands on the page that now says the same thing. */
  redirects: {
    '/docs/': '/docs/getting-started/',
    '/docs/database-browser/': '/docs/browsing/',
    '/docs/quickstart-browse/': '/docs/getting-started/',
    '/docs/walk/': '/docs/browsing/',
    '/docs/cli-browser/': '/docs/cli/',
    '/docs/changelog/': 'https://github.com/rbaljinder/tablewalk/blob/main/CHANGELOG.md',
  },
  integrations: [
    starlight({
      /* A broken link or anchor fails the build. */
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false })],
      title: 'tablewalk',
      description:
        'A read-only-by-default database browser for SQLite and PostgreSQL: follow foreign keys both ways, ask in one line, and give a coding agent the same view over MCP.',
      favicon: '/assets/favicon.svg',
      logo: { light: './src/assets/mark-light.svg', dark: './src/assets/mark-dark.svg' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rbaljinder/tablewalk' }],
      customCss: ['./src/styles/custom.css'],
      /* Code in GitHub's plain themes on the page's own ground, set in the same mono as inline code. */
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        /* A long query or JSON line wraps under its own indent rather than putting a scrollbar on the block: on a phone
           most examples are wider than the screen, and a sideways scroll hides the half of the line that matters. */
        defaultProps: { wrap: true, preserveIndent: true },
        styleOverrides: {
          borderRadius: '8px',
          borderColor: 'var(--sl-color-hairline-light)',
          codeBackground: 'var(--tw-code-bg)',
          codeFontFamily: 'var(--__sl-font-mono)',
          uiFontFamily: 'var(--__sl-font)',
          frames: {
            shadowColor: 'transparent',
            editorTabBarBackground: 'var(--tw-code-bar)',
            editorActiveTabBackground: 'var(--tw-code-bg)',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'transparent',
            terminalTitlebarBackground: 'var(--tw-code-bar)',
            terminalBackground: 'var(--tw-code-bg)',
          },
        },
      },
      components: {
        Hero: './src/components/Hero.astro',
        MarkdownContent: './src/components/MarkdownContent.astro',
      },
      head: [
        { tag: 'link', attrs: { rel: 'preload', href: '/fonts/inter-latin.woff2', as: 'font', type: 'font/woff2', crossorigin: '' } },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://tablewalk.dev/shots/record.webp' } },
      ],
      /* In the order a reader takes it: start, browse, ask, keep, edit, connect, hand it to an agent, then look
         something up. Each page is in exactly one place. */
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Home', slug: 'index' },
            { label: 'Getting started', slug: 'docs/getting-started' },
            { label: 'Desktop app', slug: 'docs/desktop' },
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'Browsing', slug: 'docs/browsing' },
            { label: 'Query language', slug: 'docs/query' },
            { label: 'Pages, layouts and views', slug: 'docs/pages' },
            { label: 'Writing', slug: 'docs/writing' },
            { label: 'Connections and config', slug: 'docs/connections' },
          ],
        },
        {
          label: 'Agents',
          items: [{ label: 'MCP for coding agents', slug: 'docs/mcp' }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Keyboard', slug: 'docs/keyboard' },
            { label: 'Command line', slug: 'docs/cli' },
            { label: 'Deploying', slug: 'docs/deploying' },
            { label: 'FAQ and troubleshooting', slug: 'docs/faq' },
            { label: 'Changelog', link: 'https://github.com/rbaljinder/tablewalk/blob/main/CHANGELOG.md' },
          ],
        },
      ],
    }),
  ],
});
