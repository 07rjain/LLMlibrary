# Security Scan Recheck

Rechecked against the current workspace on 2026-06-16. The original scan report is `security_scan/8649691_20260615T135727Z/report.md`.

## Validation Rubric

- [x] Claimed attacker-controlled input is identifiable.
- [x] Claimed sink/control point exists in current source.
- [x] Existing guards or documentation were checked for counterevidence.
- [x] Runtime reproduction was attempted where it materially changes confidence.
- [x] Severity is calibrated against library-level reachability and downstream integration assumptions.

## Closure Table

| # | Finding | Disposition | Survives | Confidence | Notes |
|---|---|---|---|---|---|
| 1 | SessionApi accepts caller-selected tenant ids when no middleware context is installed | reportable | yes | high | Reproduced with `InMemorySessionStore`: create under body `tenantId`, unauthenticated read fails without tenant id and succeeds with `?tenantId=...`. Intended middleware in docs reduces this to an integration footgun, not a false positive. |
| 2 | SessionApi returns unsanitized LLM and generic error details to HTTP/SSE callers | reportable | yes | high | Reproduced HTTP JSON path with `LLMError` containing API key, bearer token, and DB URL. `LLMError.toJSON()` redacts, but `SessionApi` bypasses it by returning raw `message` and `details`. |
| 3 | Tool schemas are not enforced before model-directed local tool execution | reportable | yes | high | Reproduced with mocked tool call: extra property and wrong type reached `execute(args)` unchanged despite declared schema. Impact depends on callback behavior. |
| 4 | Tool timeout and cancellation do not cancel the underlying tool operation | reportable | yes | high | Reproduced: side effect was false when `send()` returned and true after a later wait, proving timeout only stops waiting and does not cancel the callback. |
| 5 | OpenAI transcription fetches caller-controlled audio URLs from the library runtime | reportable | yes | high | Reproduced through `OpenAIAdapter.transcribe()`: first fetch was `http://169.254.169.254/...`, followed by OpenAI upload endpoint. |
| 6 | Raw dimensions value is interpolated into exported pgvector index SQL | reportable | yes | high | Reproduced via `createPgvectorHnswIndexSql()` with a string-cast payload; output contained `DROP TABLE sensitive`. |
| 7 | In-memory knowledge store treats missing retrieval filter as match-all | reportable | yes | medium | Reproduced: unfiltered search returned chunks from two tenants; explicit tenant filter returned only one. Low severity remains appropriate unless this store is used in shared production deployments. |

## Priority

Fix first: findings 1, 2, 5, and 6 because they have direct cross-tenant, disclosure, SSRF, or SQL-injection impact when exposed by a downstream app.

Fix next: findings 3 and 4 because model-directed tool execution is central to the chatbot SaaS use case and downstream tools may touch databases or side-effecting systems.

Document or guard: finding 7. Either make unfiltered in-memory retrieval explicitly single-tenant/demo-only or add an opt-in flag for match-all searches.
