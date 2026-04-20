# Provider Comparison

This library currently ships first-party adapters for Anthropic, OpenAI, and Google Gemini.

## Capability Matrix

| Provider | Models seeded in registry | Streaming | Tool calling | Vision inputs | Session persistence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic | `claude-sonnet-4-6`, `claude-haiku-3-5` | Yes | Yes | Yes | Via `Conversation` + session stores | Anthropic cache read/write pricing is modeled separately. |
| OpenAI | `gpt-4o`, `gpt-4o-mini`, `o1-mini` | Yes | Yes | Yes | Via `Conversation` + session stores | Uses the stateless Responses API today with `store: false` and library-owned history replay. |
| Google Gemini | `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash` | Yes | Yes | Yes | Via `Conversation` + session stores | Streaming uses the dedicated `streamGenerateContent` endpoint. |

## Translation Differences

| Concern | Anthropic | OpenAI | Gemini |
| --- | --- | --- | --- |
| System prompt handling | Lifted into `system` blocks | Flattened into top-level `instructions` | Lifted into `systemInstruction` |
| Assistant role name | `assistant` | `assistant` | `model` |
| Tool call payload | `tool_use` blocks | `function_call.arguments` JSON string with `call_id` | `functionCall.args` object |
| Tool result payload | `tool_result` block in a user turn | `function_call_output` item keyed by `call_id` | `functionResponse` part in a user turn |
| Streaming terminator | SSE close / `message_stop` | `response.completed` / stream close | SSE close on dedicated stream endpoint |

## Choosing a Provider

- Choose OpenAI when you want Responses-first model coverage, automatic prompt caching on supported models, and the broadest ecosystem compatibility.
- Choose Anthropic when long-context tool workflows or prompt caching behavior are central to the workload.
- Choose Gemini when you need a single provider surface that is comfortable with mixed text, vision, document, and audio inputs.

## Operational Notes

- All three adapters normalize token usage into a shared `UsageMetrics` shape and estimate cost from the model registry.
- All three adapters map auth, rate-limit, context-window, and generic provider failures into typed `LLMError` subclasses.
- Live-provider smoke tests can be executed with `LIVE_TESTS=1 pnpm test:live` after populating `.env`.
