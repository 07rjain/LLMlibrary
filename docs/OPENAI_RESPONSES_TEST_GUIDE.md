# OpenAI Responses Migration — Test Writing Guide

Prepared: `2026-04-21`

This document tells an AI model (or human engineer) **what to test, where to test it, and what invariants to enforce** for the Chat Completions → Responses migration. It does not contain test code. It is a specification for writing tests.

---

## Guiding Principles

1. **Every test must confirm a specific mapping claim** from the migration report — not just that the code runs.
2. **Mock at the HTTP boundary.** Intercept the outgoing `fetch` call to `/v1/responses`. Do not call the live OpenAI API.
3. **Assert the request body**, not just the response. Most migration bugs live in the translator, not the parser.
4. **Canonical types are the contract.** Inputs are always canonical library types. Outputs must round-trip back to canonical types without leaking Responses-specific fields.
5. **Regression tests must prove no public API surface changed.** `LLMClient.complete()`, `LLMClient.stream()`, `Conversation`, and `SessionApi` must behave identically from the caller's perspective.

---

## Files That Need Tests

| File | Why |
|---|---|
| `test/openai.adapter.test.ts` | Primary home for all request-translation and response-parsing tests |
| `test/provider-mock-server.test.ts` | HTTP-level mock server tests — update to serve Responses-shaped payloads |
| `test/client.test.ts` | Public API regression tests — confirm `complete()` and `stream()` contract is unchanged |
| `test/cost.test.ts` | Update to assert Responses usage field normalization |

---

## Area 1 — Request Translation

### What the adapter must produce

The outgoing request body sent to `/v1/responses` must match this shape. Tests should capture the serialized request body and assert each field.

**Fields that must be present:**

- `model` — passed through unchanged
- `input` — array of translated input items (see below)
- `store: false` — must always be present, no exceptions
- `max_output_tokens` — mapped from canonical `maxTokens`
- `temperature` — passed through when provided

**Fields that must never be present:**

- `messages` — this is the Chat Completions field; Responses uses `input`
- `max_completion_tokens` — replaced by `max_output_tokens`
- `previous_response_id` — must never appear
- `conversation` — must never appear

---

### Sub-area: System prompt handling

The adapter must consolidate all system content into the top-level `instructions` field.

| Scenario | What to assert |
|---|---|
| `options.system` is a non-empty string | `instructions` equals that string; no system-role item appears in `input` |
| Canonical history contains a `system`-role message | Its content is merged into `instructions` |
| Both `options.system` and a canonical system message exist | Both are merged into one `instructions` string |
| No system content exists at all | `instructions` field is omitted from the request body entirely |

---

### Sub-area: Canonical message → `input` item mapping

Each canonical message type must translate to the correct Responses input item shape. A single canonical message may produce **more than one** input item.

| Canonical input | Expected `input` items |
|---|---|
| User text message | One `{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }` item |
| User image-url message | One user `message` item with `input_image` content |
| User image-base64 message | One user `message` item with `input_image` content (base64 form) |
| Assistant text message | One `{ type: "message", role: "assistant", content: [{ type: "output_text", text: "..." }] }` item |
| Assistant message containing tool calls | One assistant `message` item **plus** one `function_call` item per tool call |
| User message containing tool results | One `function_call_output` item per result (no wrapping `message` item) |
| Multi-turn history (user → assistant → user) | Items appear in the same chronological order as the canonical history |

---

### Sub-area: Tool definitions

| Scenario | What to assert |
|---|---|
| A canonical tool is translated | Shape is `{ type: "function", name, description, parameters }` — no nested `function` wrapper |
| A canonical tool is translated | `strict: false` is explicitly set on every custom function tool |
| No tools provided | `tools` field is omitted or empty |

---

### Sub-area: Tool choice

| Canonical tool choice | Expected Responses `tool_choice` value |
|---|---|
| `"auto"` | `"auto"` |
| `"none"` | `"none"` |
| `"any"` | `"required"` |
| `{ tool: "my_function" }` (forced) | `{ type: "function", name: "my_function" }` |

---

### Sub-area: Parallel tool use

| Canonical option | Expected Responses field |
|---|---|
| `disableParallelToolUse: true` | `parallel_tool_calls: false` in the request body |
| `disableParallelToolUse: false` (or absent) | `parallel_tool_calls: true` or the field is omitted |

---

## Area 2 — Response Parsing

Tests here should feed a synthetic Responses JSON payload into the adapter's parser and assert the canonical output.

### What a Responses payload looks like (for fixture construction)

```
{
  "id": "...",
  "object": "response",
  "status": "completed",
  "output": [
    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Hello" }] },
    { "type": "function_call", "call_id": "call_abc", "name": "get_weather", "arguments": "{\"city\":\"London\"}" }
  ],
  "usage": {
    "input_tokens": 20,
    "output_tokens": 10,
    "input_tokens_details": { "cached_tokens": 5 }
  }
}
```

### Assertions for each output item type

| Fixture `output` content | Expected canonical field |
|---|---|
| One assistant `message` item with `output_text` | `response.text` equals the concatenated text |
| Multiple `output_text` parts in one message | `response.text` concatenates them in order |
| One `function_call` item | `response.toolCalls` contains one entry with correct `name` and parsed `arguments` |
| Multiple `function_call` items | `response.toolCalls` contains one entry per item |
| A `reasoning` item in `output` | It is silently ignored — does not appear in `response.text` or `response.toolCalls` |
| Mix of text and function calls | Both appear in canonical `response.content` parts |

---

### Finish reason mapping

| Responses `output` content | Expected canonical `finishReason` |
|---|---|
| No `function_call` items, `status: "completed"` | `"stop"` |
| At least one `function_call` item present | `"tool_call"` |
| `status: "incomplete"` | Should map conservatively (not `"stop"`); raw payload must be attached |
| `status: "failed"` or error state | Should surface as a provider error, not a normal response |

---

## Area 3 — Streaming

Tests here should feed a sequence of synthetic SSE event strings into the stream assembler and assert the canonical `StreamChunk` sequence emitted.

### Event sequences to cover

**Plain text response:**

```
response.created
response.output_item.added  (type: "message")
response.output_text.delta  (delta: "Hello")
response.output_text.delta  (delta: " world")
response.output_text.done
response.output_item.done   (type: "message")
response.completed
```

Expected canonical chunks: `text-delta("Hello")`, `text-delta(" world")`, `done`

---

**Single tool call:**

```
response.created
response.output_item.added        (type: "function_call", name: "get_weather", call_id: "call_abc")
response.function_call_arguments.delta  (delta: "{\"city\":")
response.function_call_arguments.delta  (delta: "\"London\"}")
response.function_call_arguments.done
response.output_item.done         (type: "function_call", arguments: "{\"city\":\"London\"}", call_id: "call_abc")
response.completed
```

Expected canonical chunks: `tool-call-start`, `tool-call-delta` × 2, `tool-call-result`, `done`

---

**Multiple tool calls interleaved:**

Confirm that each tool call's `call_id` is tracked independently and does not bleed into the other call's deltas.

---

**`response.completed` carries usage:**

Assert that the `done` chunk contains normalized `inputTokens`, `outputTokens`, and `cachedTokens` from the event's `usage` object.

---

**Error event:**

```
error  { message: "...", code: "..." }
```

Assert that the stream emits an `error` chunk (or throws), not a silent completion.

---

## Area 4 — Usage and Cost Normalization

These tests target `src/utils/cost.ts` (or wherever usage normalization lives in the OpenAI adapter).

| Input usage object | Expected canonical `UsageMetrics` fields |
|---|---|
| `{ input_tokens: 100, output_tokens: 50 }` | `inputTokens: 100`, `outputTokens: 50`, `cachedTokens: 0` |
| `{ input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 } }` | `cachedTokens: 20` |
| `{ input_tokens: 0, output_tokens: 0 }` | All token counts are zero; no division-by-zero error |
| Legacy Chat Completions shape (`prompt_tokens`, `completion_tokens`) during rollout | If backward-compat parsing is kept: still normalizes correctly |

Cost calculation:

- Assert that `costUSD` is computed from the model's registered pricing and the normalized token counts.
- Assert that `cachedTokens` reduces the effective input cost as expected.

---

## Area 5 — Conversation Loop (End-to-End)

These tests use `MockLLMClient` (or a mock `fetch`) and verify that `Conversation.send()` works correctly through a multi-turn tool loop without relying on OpenAI state.

### Scenarios

**Single turn, no tools:**

1. Call `Conversation.send("Hello")`
2. Mock returns one assistant text response
3. Assert the returned text is correct
4. Assert conversation history now contains one user message and one assistant message

**Single tool call, then text:**

1. Call `Conversation.send("What is the weather?")`
2. Mock round 1 returns a `function_call` for `get_weather`
3. Tool executes, returns a result
4. Mock round 2 returns an assistant text message
5. Assert final text is from round 2
6. Assert history contains: user message, assistant tool-call message, tool-result message, assistant text message

**State ownership invariants — assert on every request sent to the mock:**

- The request body never contains `previous_response_id`
- The request body never contains `conversation`
- `store: false` is present on every request
- The full conversation history is re-sent as `input` on every turn (not just the latest message)

---

## Area 6 — Public API Regression

These tests confirm that the public-facing surface of the library is unchanged.

| Public method | What to assert |
|---|---|
| `LLMClient.complete(options)` | Returns a `CanonicalResponse` with `text`, `toolCalls`, `usage`, and `finishReason` populated |
| `LLMClient.stream(options)` | Returns an async iterable of `StreamChunk`; chunks arrive in the expected order |
| `Conversation.send(message)` | Returns the assistant's reply text; history is updated |
| `SessionApi` endpoints | Same request/response contract as before — transport change is not visible to API consumers |

No caller-facing type should change. If a test needs to import a Responses-specific type to compile, that is a sign the abstraction leaked.

---

## Mock Fixture Checklist

When writing tests, build these fixtures:

- [ ] Minimal Responses JSON response (text only, no tools)
- [ ] Responses JSON response with one `function_call` in `output`
- [ ] Responses JSON response with multiple `function_call` items
- [ ] Responses JSON response with a `reasoning` item (to test that it is ignored)
- [ ] Responses JSON response with `status: "incomplete"`
- [ ] SSE stream for plain text (sequence of `response.output_text.delta` events)
- [ ] SSE stream for a single tool call (full event lifecycle)
- [ ] SSE stream for two concurrent tool calls
- [ ] SSE stream ending with `error` event
- [ ] Usage object with `input_tokens_details.cached_tokens` present
- [ ] Usage object with no `input_tokens_details` (cached tokens absent)

---

## What Not To Test Here

- Internal Responses API behavior (OpenAI's responsibility)
- Azure OpenAI compatibility (separate concern, separate tests)
- Built-in Responses tools like `web_search` or `file_search` (out of scope for parity migration)
- Strict-mode tool schemas — `strict: false` is the parity baseline; strict-mode opt-in is a later feature
- `allowed_tools` tool-choice shape — not yet supported

---

## Coverage Gate

A migration PR should not merge unless the following are all green:

- [ ] All request-translation scenarios in Area 1
- [ ] All response-parsing scenarios in Area 2
- [ ] All streaming event sequences in Area 3
- [ ] Usage normalization in Area 4
- [ ] Conversation loop state-ownership invariants in Area 5
- [ ] Public API regression suite in Area 6
- [ ] `store: false` is asserted in at least one test per transport path (complete and stream)
- [ ] `previous_response_id` absence is asserted in at least one conversation-loop test
