# Changelog

All notable changes to this project will be tracked here.

## 0.1.0 - 2026-04-16

### feat

- add a unified `LLMClient` surface for Anthropic, OpenAI, and Gemini with shared request, response, streaming, and tool abstractions
- add `Conversation` state management, context trimming strategies, durable session stores, routing, and usage logging
- add a framework-agnostic `SessionApi` with lifecycle endpoints, SSE streaming, and Responses-style mapping notes

### test

- add provider mock-server coverage for realistic text, tool, stream, and rate-limit flows
- add cross-tenant Session API isolation coverage, lifecycle inspection coverage, and optional live smoke tests behind `LIVE_TESTS=1`
- add automated bundle-size, request-overhead, long-run conversation, and concurrent-session checks

### docs

- add Session API mapping documentation, provider comparison guidance, migration guidance, Typedoc generation, and GitHub Pages publishing workflow
