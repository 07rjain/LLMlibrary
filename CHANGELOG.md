# Changelog

All notable changes to this project will be tracked here.

## 0.3.0 - 2026-11-15

### feat

- support OpenAI PDF user inputs from inline base64 or HTTPS URLs through
  completion, streaming, and restored conversations
- add `providerOptions.openai.verbosity` for compatible GPT-5/GPT-6 models,
  including requests with structured output
- expose provider-authored OpenAI summaries as `reasoningSummary` and existing
  reasoning stream events without mixing them into answers or persisted history
- inspect PDF, verbosity, and reasoning-summary support with
  `client.models.getResponseCapabilities()`; reject unsupported OpenAI response
  controls after model switches by default, or explicitly omit them with
  `providerOptions.unsupportedFeaturePolicy: 'omit'` without removing PDF inputs
- register GPT-6 Astra, GPT-6.1 Sol/Terra, GPT-6 Luna, Claude Fable 5.2,
  Claude Opus/Sonnet/Haiku 5.5, Gemini 4 Carbon/Argon/Hydrogen, and Gemini 3.8 Flash
- add `gpt-transcribe` for file transcription and use it as the default STT model
- expose lifecycle metadata and `client.models.resolve()`; reject confirmed
  retirements before dispatch while retaining deprecated IDs until shutdown
- apply announced Google redirects before routing, quoting, dispatch, and usage accounting
- apply scheduled Standard token prices and prompt-length pricing tiers, including
  Haiku 5.5 cache tokens; reject expired promotional pricing without verified successor rates

### fix

- apply response feature policy per dispatched fallback attempt and preserve it
  in restored conversations; check PDF vision capability across all three adapters
- refresh provider pricing sources and verification dates, including GPT-5.6 Sol
  promotional rates and Gemini Flash promotional rates and future price schedules
- validate current Claude thinking modes, GPT-6 reasoning/sampling combinations,
  and Gemini 4 thinking/caching options before transport
- allow audio model metadata to omit an unpublished token context window;
  completion and embedding models still require a positive window

### compatibility

- default file transcription to `gpt-transcribe`; explicitly select a compatible
  legacy model when requesting diarization, timestamps, or speaker controls
- reject unsupported OpenAI verbosity/reasoning settings after model switches;
  set `providerOptions.unsupportedFeaturePolicy: 'omit'` to accept omission of
  unsupported response controls while preserving input content
- resolve provider-confirmed redirects and reject models past confirmed shutdown
  dates; update model selections using the documented lifecycle migration table

### docs

- document current model prices, API retirement dates, redirects, migration
  requirements, and audio integrations that need a separate Realtime adapter

## 0.2.2 - 2026-08-20

### feat

- support OpenAI GPT-5.6 `max` reasoning effort
- add OpenAI explicit prompt-cache options and per-part user text/image cache breakpoints
- normalize and price OpenAI cache-write token usage

### fix

- refresh GPT-5.6 Luna and Terra pricing metadata
- keep provider-specific OpenAI validation out of unrelated provider bundles

## 0.2.1 - 2026-08-04

### fix

- bind Postgres optimistic updates correctly
- refresh verified model pricing dates

### test

- cover every published package export entry point

## 0.2.0 - 2026-08-04

### feat

- add strict provider, request, metadata, registry, retrieval, session, budget,
  reasoning, and conversation-snapshot validation
- add atomic session concurrency controls and hardened Redis/Postgres store paths
- preserve Gemini thought signatures privately across automatic tool loops

### security

- harden agent-skill path containment, logger and warning callbacks, PII
  redaction, package export identity, and provider transport/stream boundaries
- fail closed on unknown pricing and on invalid tool dispatchers or callbacks

## 0.1.11 - 2026-07-28

### feat

- register OpenAI `gpt-5.6-luna` and Anthropic `claude-haiku-4-5-20251001` in the static model registry
- keep the stable Gemini `gemini-3.1-flash-lite` metadata current and covered by registry tests
- register the full OpenAI GPT-5.6 Sol/Terra/Luna family and `gpt-5.6` alias
- register Anthropic `claude-opus-5`, Google `gemini-3.6-flash`, and Google `gemini-3.5-flash-lite`
- omit deprecated Gemini sampling parameters for the newest Flash and Flash-Lite models

## 0.1.10 - 2026-07-27

### refactor

- keep the conversation's pre-resolved route internal to `LLMClient` instead of exposing it through the public request options

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
