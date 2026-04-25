import { defineConfig } from 'vitepress';

const repo = 'https://github.com/07rjain/LLMlibrary';

export default defineConfig({
  title: 'Unified LLM Client',
  description:
    'Provider-agnostic TypeScript client for OpenAI, Anthropic, and Gemini with streaming, tools, persistence, routing, and usage tracking.',
  base: '/LLMlibrary/',
  cleanUrls: true,
  ignoreDeadLinks: [/^\.\/api\//, /^\/api\//],
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'Unified LLM Client',
    search: {
      provider: 'local',
    },
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/GETTING_STARTED' },
      { text: 'Guides', link: '/README' },
      { text: 'API', link: '/api/index.html' },
      { text: 'GitHub', link: repo },
    ],
    sidebar: [
      {
        text: 'Start Here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Guide Hub', link: '/README' },
          { text: 'Getting Started', link: '/GETTING_STARTED' },
        ],
      },
      {
        text: 'Core Usage',
        items: [
          { text: 'Completions And Streaming', link: '/COMPLETIONS_AND_STREAMING' },
          { text: 'Conversations And Tools', link: '/CONVERSATIONS_AND_TOOLS' },
          { text: 'Persistence And Session API', link: '/PERSISTENCE_AND_SESSION_API' },
          { text: 'Session API Reference', link: '/SESSION_API_REFERENCE' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Production Guide', link: '/PRODUCTION_GUIDE' },
          { text: 'Provider Comparison', link: '/PROVIDER_COMPARISON' },
          { text: 'Migration Guide', link: '/MIGRATION_GUIDE' },
          { text: 'Cost And Pricing', link: '/COST_AND_PRICING' },
          { text: 'PRD Decisions', link: '/PRD_DECISIONS' },
          { text: 'Roadmap', link: '/ROADMAP' },
          { text: 'API Reference', link: '/api/index.html' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: 'https://github.com/07rjain/LLMlibrary/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    outline: {
      level: [2, 3],
    },
    footer: {
      message: 'Provider-agnostic LLM tooling for TypeScript applications.',
      copyright: 'Documentation for unified-llm-client',
    },
  },
});
