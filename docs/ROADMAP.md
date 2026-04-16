# Roadmap

Prepared: 2026-04-16

## Provider Expansion

- `Mistral` adapter is deferred until after the current 3-provider MVP scope.
- `Cohere` adapter is deferred until after the current 3-provider MVP scope.
- `Groq` remains a Phase 2 adapter candidate once the transport and pricing matrix expands.
- `Amazon Bedrock`, `Azure OpenAI`, and `Ollama` remain Phase 3 adapter targets.

## Observability And Platforms

- OpenTelemetry spans and trace IDs remain planned follow-up work after the current release baseline.
- Python parity remains a roadmap item; the current package is TypeScript-first.
- The current Edge target covers the core web-standard surface, while Node-only persistence stays separate.

## Open Questions

- Response caching remains intentionally unresolved.
- Any caching design must preserve provider-specific invalidation semantics, tool-call determinism, and usage accounting.
- The question stays open until there is a concrete storage and cache-invalidation strategy across providers.
