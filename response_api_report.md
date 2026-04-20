# OpenAI Responses API Migration Report

Validated: `2026-04-21`

This is a validated revision of the earlier draft. It was compared against the current OpenAI docs and against the repo-specific report in `docs/OPENAI_RESPONSES_MIGRATION_REPORT.md`.

## Validation Summary

The earlier draft was directionally correct, but it mixed verified migration facts with a few assumptions that should not be carried into implementation unchanged.

The biggest corrections are:

- `previous_response_id` does not cause OpenAI to ignore `input`. The docs show both being used together. We should still avoid it in this library, but that is a design decision, not an API limitation.
- model compatibility is not uniform across Chat Completions and Responses. Some model experiences are Responses-only or effectively Responses-first.
- Responses tool schemas are strict by default. If parity with current Chat Completions behavior matters, we should set `strict: false` explicitly in the first migration release.
- Responses finish-reason mapping is not a simple `status` rename. Tool calls can still come back with `status: "completed"`, so the adapter must inspect output items.
- OpenAI documents `parallel_tool_calls` on Responses requests, so the existing `disableParallelToolUse` mapping can carry over directly.

## Repo-Specific Recommendation

This library should migrate OpenAI to Responses without adopting OpenAI-managed conversation state.

Recommended policy:

- keep `Conversation` and `SessionApi` as the only state layer
- always send full translated history as `input`
- always send `store: false`
- do not send `conversation`
- do not send `previous_response_id`

That matches the current architecture and keeps one source of truth for history, persistence, and tool loops.

## Current Adapter State

The current OpenAI adapter is now Responses based.

- `src/providers/openai.ts`
  - `complete()` posts to `/v1/responses`
  - `stream()` posts to `/v1/responses`
  - request translation is built around `instructions` plus `input`
  - response parsing is built around typed `output` items
  - streaming parsing is built around Responses event types such as `response.output_text.delta` and `response.completed`
- `src/conversation.ts`
  - already owns multi-turn state and tool loops
- `src/session-api.ts`
  - already owns the HTTP session boundary
- `src/utils/parse-sse.ts`
  - can likely stay in place because it already reads generic `data:` SSE payloads

## What the OpenAI Docs Confirm

The official docs currently say:

- Responses is the recommended API for new projects.
- simple Chat Completions message arrays can be migrated by changing `messages` to `input`
- Responses supports top-level `instructions`
- Responses returns typed `output` items instead of `choices[].message`
- Responses uses item types such as `message`, `function_call`, and `function_call_output`
- Responses streaming uses typed events such as `response.output_text.delta` and `response.completed`
- Responses can be used with provider-managed state via `conversation` or `previous_response_id`
- Responses can also be used in manual-history mode by passing full `input`
- Responses function definitions differ from Chat Completions:
  - the nested `function` wrapper is removed
  - functions are strict by default

## Transition Approach

Do not hard-cut the adapter in one change. Use a phased migration.

### Phase 1: Dual transport

- add internal support for both:
  - `chat-completions`
  - `responses`
- keep Chat Completions as the default for the first migration PR
- implement the full Responses request, response, and stream path behind an internal switch
- add transport-parity tests

### Phase 2: Default to Responses

- switch OpenAI to Responses by default
- always send `store: false`
- keep Chat Completions as a temporary escape hatch
- update docs to describe Responses as the active OpenAI transport

### Phase 3: Remove Chat Completions

- remove `/v1/chat/completions` from the adapter
- delete Chat Completions-specific fixtures and tests
- simplify OpenAI code around one transport

## Request Mapping

Recommended Responses request shape for this library:

- `model`
- `instructions`
- `input`
- `max_output_tokens`
- `temperature`
- `tools`
- `tool_choice`
- `store: false`

### System prompt

Recommended behavior:

- map `options.system` to `instructions`
- flatten canonical `system` messages into the same `instructions` value
- omit `instructions` when empty

This preserves the adapter's current behavior without depending on OpenAI state.

### Messages and items

Recommended parity mapping:

- canonical user text or image content
  - becomes a Responses `message` item with `role: "user"`
- canonical assistant text content
  - becomes a Responses `message` item with `role: "assistant"`
- canonical assistant tool calls
  - become `function_call` items
- canonical user tool results
  - become `function_call_output` items

Important detail:

Responses treats these as separate item types. One canonical message may therefore translate into multiple Responses items. That is expected.

## Tool Translation

### Tool definitions

Chat Completions uses:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get weather",
    "parameters": { "type": "object" }
  }
}
```

Responses uses:

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get weather",
  "parameters": { "type": "object" }
}
```

Recommended parity-first behavior:

- flatten the schema for Responses
- explicitly send `strict: false` initially

Why:

- current adapter behavior follows Chat Completions semantics
- inheriting strict-by-default silently could break existing user tool schemas

### Tool choice

The docs confirm Responses support for:

- `"auto"`
- `"required"`
- `"none"`
- `{ "type": "function", "name": "..." }`
- `allowed_tools`

Recommended transition behavior:

- keep current canonical mappings for `auto`, `none`, `any`, and one forced tool
- continue mapping canonical `any` to `"required"`
- do not add `allowed_tools` yet unless product requirements justify expanding the canonical type

### Parallel tool use

The current adapter maps `disableParallelToolUse` to `parallel_tool_calls`.

Recommended transition behavior:

- preserve that mapping for Responses requests as well
- keep existing canonical behavior without widening the public API

## Response Parsing

Current parsing assumes:

- one primary choice in `choices[0]`
- text in `choices[0].message.content`
- tool calls in `choices[0].message.tool_calls`
- finish reason in `choices[0].finish_reason`

Responses parsing should instead:

- collect assistant text from `output` items of type `message`
- collect tool calls from `output` items of type `function_call`
- ignore reasoning items for parity unless explicitly exposed later

Recommended canonical mapping:

- `text`
  - concatenate `output_text` parts from assistant messages
- `toolCalls`
  - collect every `function_call` item
- `content`
  - emit canonical `text` parts from assistant message text
  - emit canonical `tool_call` parts from `function_call` items

### Finish reason

This cannot be a simple field rename.

Recommended conservative behavior:

- if any `function_call` item exists in `output`, set canonical `finishReason` to `tool_call`
- else if the response completed normally, use `stop`
- else inspect incomplete or filtered cases explicitly and keep the raw payload attached

This must be test-driven because Responses `status` is not a one-to-one replacement for Chat Completions `finish_reason`.

## Streaming

This is the highest-risk implementation area besides tool translation.

The current assembler expects:

- `chat.completion.chunk`
- `choices[0].delta.content`
- `choices[0].delta.tool_calls`
- `[DONE]`

Responses streaming instead uses typed events such as:

- `response.created`
- `response.output_text.delta`
- `response.output_item.added`
- `response.function_call_arguments.delta`
- `response.output_item.done`
- `response.completed`
- `error`

### Good news

`src/utils/parse-sse.ts` can likely stay unchanged because it already:

- reads `data:` payloads
- ignores non-`data:` lines such as `event:`
- yields one JSON payload per event

### Recommended stream mapping

- `response.output_text.delta`
  - emit canonical `text-delta`
- `response.output_item.added` where `item.type === "function_call"`
  - emit canonical `tool-call-start`
- `response.function_call_arguments.delta`
  - emit canonical `tool-call-delta`
- `response.output_item.done` where `item.type === "function_call"`
  - emit canonical `tool-call-result`
- `response.completed`
  - emit canonical `done` with usage
- `error`
  - surface provider error

## Usage and Cost

Chat Completions usage fields:

- `prompt_tokens`
- `completion_tokens`
- `prompt_tokens_details.cached_tokens`

Responses usage fields:

- `input_tokens`
- `output_tokens`
- `input_tokens_details.cached_tokens`

Recommended rollout behavior:

- temporarily support parsing both usage shapes in `src/utils/cost.ts`
- switch tests and transport to Responses
- remove Chat Completions usage parsing only after the fallback path is gone

## Concrete Code Areas

Primary changes:

- `src/providers/openai.ts`
  - new Responses request translator
  - new Responses response parser
  - new Responses stream assembler
  - explicit `store: false`
- `src/utils/cost.ts`
  - support Responses usage field mapping

Likely unchanged:

- `src/conversation.ts`
- `src/session-api.ts`
- `src/utils/parse-sse.ts`

Tests that will need work:

- `test/openai.adapter.test.ts`
- `test/provider-mock-server.test.ts`
- `test/client.test.ts`

## Key Corrections Versus the Earlier Draft

These were the main issues I corrected from the previous version of this file:

1. `previous_response_id`
   The earlier draft said sending it would cause OpenAI to ignore `input`. That is not what the docs show. We should omit it here because of our architecture, not because the API cannot combine it with `input`.

2. Model compatibility
   The earlier draft implied model IDs are effectively the same across both APIs. That is too broad. Some model experiences are Responses-only or Responses-first.

3. Strict function schemas
   The earlier draft described the schema difference but did not turn it into a rollout recommendation. That would be risky. The migration should account for strict-by-default behavior explicitly.

4. Finish-reason mapping
   The earlier draft mapped `status` too directly to canonical finish reasons. That is not robust enough because tool calls can still return with `status: "completed"`.

5. `disableParallelToolUse`
   The earlier draft flagged this as unverified. The current OpenAI docs do document `parallel_tool_calls` on Responses requests, so the mapping can be preserved.

6. Speculation
   The earlier draft included a speculative Azure fallback note. That is product planning, not a verified migration fact from the OpenAI docs.

## Recommended Next Step

If the next task is implementation, the safest order is:

1. add dual transport support internally
2. implement Responses request translation
3. implement Responses response parsing
4. implement Responses streaming
5. update usage normalization
6. switch default transport to Responses
7. remove Chat Completions after parity testing

## Source Links

- OpenAI migration guide: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI conversation state guide: https://developers.openai.com/api/docs/guides/conversation-state
- OpenAI streaming guide: https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI function calling guide: https://developers.openai.com/api/docs/guides/function-calling
- OpenAI models overview: https://developers.openai.com/api/docs/models
- OpenAI model comparison: https://developers.openai.com/api/docs/models/compare
- OpenAI `o1-pro` model page: https://developers.openai.com/api/docs/models/o1-pro
- OpenAI `o3-pro` model page: https://developers.openai.com/api/docs/models/o3-pro
- OpenAI `computer-use-preview` model page: https://developers.openai.com/api/docs/models/computer-use-preview
