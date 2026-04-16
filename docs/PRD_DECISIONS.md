# PRD Decisions

Prepared: 2026-04-16

## Authority

- The implementation baseline is the shipped task-report MVP plus explicit PRD addenda that are now represented in code, CI, or roadmap docs.
- The task report remains authoritative for launch scope and execution order when it conflicts with the older PRD launch narrative.
- The PRD remains authoritative for non-conflicting product intent, roadmap items, and quality requirements that were absorbed after MVP delivery.

## Launch Scope

- Authoritative launch scope is the current 3-provider MVP: Anthropic, OpenAI, and Google Gemini.
- `Mistral` and `Cohere` are deferred to the roadmap rather than blocking the current release.
- `Groq`, `Amazon Bedrock`, `Azure OpenAI`, and `Ollama` stay as roadmap items after the 3-provider baseline.

## Adapter Strategy

- The project keeps raw `fetch`-based provider adapters for the current release.
- `LiteLLM` and `Vercel AI SDK` are recorded as future evaluation options, not current transport dependencies.
- This keeps provider-specific behavior visible and avoids adding an abstraction layer that would hide finish reasons, usage shapes, or retry semantics.

## Launch Matrix

- The authoritative launch model matrix is the set of implemented models in [src/models/prices.json](../src/models/prices.json).
- `prices.json` is the source of truth for launch pricing metadata and is intentionally limited to models the codebase can actually route today.
- Models tied to deferred providers stay in the roadmap until the corresponding adapters exist.

## Phase Mapping

- Summarisation trimming is available now through `SummarisationStrategy`.
- Weighted A/B routing is available now through `ModelRouter`.
- Postgres usage logging is available now through `PostgresUsageLogger`.
- `client.getUsage()` and `client.exportUsage()` are available now when a usage logger supports aggregation.
- These capabilities are treated as shipped in the current release even if the older PRD described them as later-phase work.

## Runtime Targets

- Package output remains dual `ESM + CJS`.
- Core modules are verified for Edge-style runtimes through `pnpm edgecheck`.
- `PostgresSessionStore` and `PostgresUsageLogger` remain Node-oriented because they lazily load `pg`.
- Browser support is limited to the core client, conversations, routing, in-memory storage, and the web-standard `SessionApi`. Node-only persistence features are explicitly excluded from the browser target.
