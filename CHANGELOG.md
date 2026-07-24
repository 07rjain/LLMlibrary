# Changelog

All notable changes to this project will be tracked here.

## 0.1.9 - 2026-07-25

### fix

- resolve routed model/provider values from streaming `response-start` events before external tool dispatch
- make `estimateRequest()` quote the primary `ModelRouter` attempt and keep budget preflight on that resolved attempt
- resolve the initial conversation route before context trimming and account for model context, reserved output, and tool-schema budgets
- include Session API request IDs on the initial SSE event and early stream errors

### feat

- propagate JSON-safe request metadata and `requestId` through direct requests, Conversation turns, Session API messages, context callbacks, stream events, and usage logs

### test

- add regression coverage for router-only estimates, implicit streaming dispatch, per-step context correlation, usage logging, and Session API propagation
- strengthen live conformance checks for billable usage, stream sequencing, and canonical tool arguments

### docs

- document request metadata, end-to-end usage correlation, and the 0.1.9 release scope

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
