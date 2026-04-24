# OpenAI Responses Migration Report

Prepared: `2026-04-21`  
Updated: `2026-04-25`

This report documents the replacement of the OpenAI adapter's use of `POST /v1/chat/completions` with `POST /v1/responses` while keeping this library's own `Conversation` and `SessionApi` as the source of truth for history and persistence.

Current status:

- the OpenAI adapter now uses the Responses API only
- `store: false` is sent explicitly
- library-owned `Conversation` and `SessionApi` state remain the source of truth
- the earlier dual-transport rollout notes below are historical migration planning, not the current runtime design

## Objective

The goal is not to adopt OpenAI's conversation-state model. The goal is:

- keep `LLMClient.complete()`, `LLMClient.stream()`, `Conversation`, and `SessionApi` unchanged at the public API level
- switch the OpenAI transport from Chat Completions to Responses
- keep conversation history in the library, not in OpenAI
- use Responses in a stateless way with explicit `store: false`

That gives us a safer migration path and avoids splitting state ownership between this library and OpenAI.

## Current Codebase State

The OpenAI adapter is now Responses based.

- `src/providers/openai.ts`
  - `complete()` posts to `/v1/responses`
  - `stream()` posts to `/v1/responses`
  - request translation is built around `instructions` plus `input`
  - response parsing is built around typed `output` items
  - streaming parsing is built around Responses events such as `response.output_text.delta` and `response.completed`
- `src/client.ts`
  - routes OpenAI requests through `OpenAIAdapter` without exposing transport details
- `src/conversation.ts`
  - already owns multi-turn state, tool loops, persistence, totals, and replay
- `src/session-api.ts`
  - already provides the HTTP-facing session layer
- `src/utils/parse-sse.ts`
  - is generic enough to keep using because it reads `data:` payloads and ignores other SSE lines

This architecture is favorable for migration. Most of the change is isolated to the OpenAI adapter and its tests.

## What the OpenAI Docs Confirm

The official OpenAI docs currently say:

- The Responses API is the recommended API for new projects.
- Simple message inputs are compatible between Chat Completions and Responses if you change `messages` to `input`.
- Responses supports `instructions` as a top-level system-style field.
- Responses returns `output` items rather than `choices[].message`.
- Responses uses typed items such as `message`, `function_call`, and `function_call_output`.
- Responses streaming emits typed lifecycle events such as `response.output_text.delta` and `response.completed`.
- OpenAI supports automatic conversation state in Responses via `conversation` or `previous_response_id`, but it also documents manual-history mode where you pass full `input` and set `store: false`.
- Function definitions differ in Responses:
  - the nested `function` wrapper is removed
  - functions are strict by default
- OpenAI documents additional tool-choice shapes in Responses, including `allowed_tools`.

The docs also note benefits that matter here:

- better support for reasoning models
- built-in tools such as web search, file search, computer use, code interpreter, and MCP
- improved cache utilization
- access to Responses-only model experiences

## Recommended State Strategy

Do not use OpenAI `conversation` or `previous_response_id` in this library.

Use this policy instead:

- always send full translated history from the canonical conversation state
- always set `store: false`
- never send `previous_response_id`
- never send `conversation`

Why this is the right fit here:

- `Conversation` already owns the source transcript
- `SessionApi` already exposes a provider-agnostic session boundary
- the docs explicitly show manual-history Responses usage with `input=history` and `store: false`
- keeping one state owner avoids subtle drift between library history and provider history

This is the most important transition decision.

## Public API Impact

The public library surface can remain stable.

No breaking change is required for:

- `LLMClient.complete()`
- `LLMClient.stream()`
- `Conversation`
- `SessionApi`
- canonical message and tool types

The migration should be internal to the OpenAI adapter first.

## Request Translation Mapping

### Base request

Current OpenAI adapter shape:

- `model`
- `messages`
- `max_completion_tokens`
- `temperature`
- `tools`
- `tool_choice`
- `parallel_tool_calls`

Recommended Responses shape:

- `model`
- `instructions`
- `input`
- `max_output_tokens`
- `temperature`
- `tools`
- `tool_choice`
- `store: false`

### System prompt handling

The migration guide says simple message arrays can be passed directly as `input`, including system messages, but Responses also supports cleaner top-level `instructions`.

Recommended library behavior:

- map `options.system` to `instructions`
- flatten canonical `system` messages into the same `instructions` string
- omit `instructions` entirely when empty

That preserves the current adapter's effective behavior, where system content is normalized ahead of user turns, without introducing OpenAI-specific state semantics.

### Canonical messages to Responses input

Recommended parity mapping:

- Canonical user text or image content
  - becomes a `message` item with `role: "user"`
- Canonical assistant text content
  - becomes a `message` item with `role: "assistant"`
- Canonical assistant tool calls
  - become separate `function_call` items
- Canonical user tool results
  - become separate `function_call_output` items

Important detail:

Responses treats `message`, `function_call`, and `function_call_output` as separate items. That means a single canonical message may translate into more than one Responses input item. This is normal and should be handled explicitly.

### Tool definitions

The docs call out two significant differences:

- Chat Completions uses `{ type: "function", function: { ... } }`
- Responses uses `{ type: "function", name, description, parameters }`

The docs also state that Responses functions are strict by default.

This is a migration risk.

Recommended parity-first behavior:

- flatten the request tool shape for Responses
- explicitly set `strict: false` on custom function tools in the first migration release

Reason:

- current Chat Completions behavior is non-strict by default
- silently inheriting Responses strict mode could break existing schemas and tool-call behavior
- parity matters more than “taking the new default” on the first rollout

After the transport migration is stable, strict mode can be exposed as an opt-in provider-specific option.

### Tool choice

The docs confirm these Responses values:

- `"auto"`
- `"required"`
- `"none"`
- `{ "type": "function", "name": "..." }`
- `allowed_tools`

The current canonical tool-choice type only models:

- `auto`
- `any`
- `none`
- one forced tool

Recommended transition behavior:

- keep current mappings for `auto`, `none`, `any`, and one forced tool
- continue mapping canonical `any` to `"required"`
- do not add `allowed_tools` yet unless there is a separate product need

### Parallel tool use

The current OpenAI Chat Completions adapter maps `disableParallelToolUse` to `parallel_tool_calls`.

The current OpenAI docs also document `parallel_tool_calls` on Responses requests.

Recommended transition behavior:

- preserve the current `disableParallelToolUse` mapping by forwarding it to Responses `parallel_tool_calls`
- keep the canonical tool-choice surface unchanged for the migration

That keeps existing library behavior intact without introducing a transport-specific public option.

## Response Parsing Mapping

Current parser logic assumes:

- one primary choice in `choices[0]`
- text on `choices[0].message.content`
- tool calls on `choices[0].message.tool_calls`
- finish reason on `choices[0].finish_reason`

Responses requires different parsing:

- text must be collected from `output` items of type `message`
- tool calls must be collected from `output` items of type `function_call`
- tool results are not returned as assistant text; they are items in the trace
- reasoning items may appear and should be ignored for parity unless later exposed

Recommended canonical mapping:

- `text`
  - concatenate `output_text` parts from assistant `message` items
- `toolCalls`
  - collect every `function_call` item
- `content`
  - create canonical `text` parts from assistant message text
  - create canonical `tool_call` parts from each `function_call`

### Finish reason mapping

This needs deliberate handling.

The migration guide shows:

- Responses uses `status`
- tool calls may still come back with `status: "completed"`

Recommended conservative mapping:

- if any `function_call` item is present in `output`, use canonical `finishReason: "tool_call"`
- else if the response completed normally, use `stop`
- else map incomplete or filtered states conservatively and keep raw payload attached

This is one area where implementation should prefer explicit tests over assumptions, because Responses status is not a one-to-one replacement for Chat Completions `finish_reason`.

## Streaming Migration

This is the second highest-risk area after tool translation.

The current stream assembler expects:

- `chat.completion.chunk`
- `choices[0].delta.content`
- `choices[0].delta.tool_calls`
- `[DONE]`

The docs for Responses streaming instead call out:

- `response.created`
- `response.output_text.delta`
- `response.completed`
- `error`

The function-calling guide also shows Responses stream events for tool calls:

- `response.output_item.added`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`

### Good news

`src/utils/parse-sse.ts` can probably stay unchanged.

It already:

- collects `data:` payloads
- ignores non-`data:` lines such as `event:`
- yields one JSON payload per SSE event

That means the migration does not require a new low-level SSE parser. It requires a new OpenAI stream assembler that understands Responses event payloads.

### Recommended stream assembler behavior

- on `response.output_text.delta`
  - emit canonical `text-delta`
- on `response.output_item.added` where `item.type === "function_call"`
  - emit canonical `tool-call-start`
- on `response.function_call_arguments.delta`
  - emit canonical `tool-call-delta`
- on `response.output_item.done` where `item.type === "function_call"`
  - finish and emit canonical `tool-call-result`
- on `response.completed`
  - emit canonical `done` with usage
- on `error`
  - surface provider error

## Usage and Cost Mapping

Current OpenAI cost normalization expects Chat Completions usage:

- `prompt_tokens`
- `completion_tokens`
- `prompt_tokens_details.cached_tokens`

Responses uses:

- `input_tokens`
- `output_tokens`
- `input_tokens_details.cached_tokens`

Recommended change:

- update OpenAI usage normalization to accept Responses fields
- optionally keep backward-compatible parsing for both shapes during rollout

Suggested rollout-safe behavior:

- parse both Chat Completions and Responses usage shapes temporarily
- switch tests and docs to Responses first
- remove Chat Completions usage parsing only after the transport fallback is gone

## Smooth Transition Plan

Historical note:

This section describes the recommended rollout before implementation. The repo has since completed the migration and removed the Chat Completions transport path.

Use a phased rollout:

### Phase 1: Add dual transport support

- add an internal OpenAI transport mode:
  - `chat-completions`
  - `responses`
- default to `chat-completions` in the first migration PR
- implement full Responses request, response, and stream translation behind the mode
- add parallel tests for both modes where practical

Why:

- it lets the repo verify parity without cutting over blindly
- it keeps Azure or edge-case fallback possible if needed

### Phase 2: Switch default to Responses

- make OpenAI Responses the default transport
- always send `store: false`
- keep the old Chat Completions mode available as a temporary escape hatch
- update docs to say OpenAI uses Responses internally

### Phase 3: Remove Chat Completions fallback

- remove `/v1/chat/completions` calls from the adapter
- remove Chat Completions-specific tests and mock payloads
- simplify OpenAI code paths around one transport model

This is the point where “replace” is complete. It should happen after parity validation, not before.

## Code Areas To Change

Primary changes:

- `src/providers/openai.ts`
  - new Responses request translator
  - new Responses response parser
  - new Responses stream assembler
  - explicit `store: false`
- `src/utils/cost.ts`
  - Responses usage field mapping

Likely no change or minimal change:

- `src/client.ts`
  - only if transport mode is exposed/configurable
- `src/conversation.ts`
  - no architectural change expected
- `src/session-api.ts`
  - no architectural change expected
- `src/utils/parse-sse.ts`
  - likely reusable as-is

Tests that will need updates:

- `test/openai.adapter.test.ts`
- `test/provider-mock-server.test.ts`
- `test/client.test.ts`

Mock fixtures that will change heavily:

- Chat Completions JSON payloads
- Chat Completions SSE chunk payloads

## Test Plan

Minimum required tests for a safe cutover:

- request translation
  - `system` and system messages become `instructions`
  - canonical history becomes `input`
  - `store: false` is always sent
- tool translation
  - custom tools flatten from Chat Completions shape to Responses shape
  - forced-tool mapping uses `{ type: "function", name }`
  - `function_call_output` uses `call_id`
- response parsing
  - assistant text message items map to canonical text
  - `function_call` items map to canonical tool calls
  - reasoning items are ignored for parity
- streaming
  - `response.output_text.delta` maps to `text-delta`
  - function-call event flow maps to `tool-call-start`, `tool-call-delta`, and `tool-call-result`
  - `response.completed` maps to `done`
- conversation loop
  - `Conversation.send()` still works with OpenAI tools end to end using library-owned history
  - no `previous_response_id`
  - no `conversation`
- usage
  - `input_tokens`, `output_tokens`, and `input_tokens_details.cached_tokens` are normalized correctly

## Risks And Open Questions

### 1. Strict-by-default tool schemas

This is the most likely source of regressions for existing users.

Recommendation:

- send `strict: false` initially for parity

### 2. `disableParallelToolUse`

The current OpenAI docs do document `parallel_tool_calls` on Responses requests.

Recommendation:

- preserve the existing mapping in Responses mode

### 3. Finish-reason parity

Responses `status` does not map one-to-one to Chat Completions `finish_reason`.

Recommendation:

- determine `tool_call` by inspecting output items
- keep raw payloads attached
- add explicit tests for incomplete and filtered cases

### 4. Built-in tools vs custom functions

Responses supports built-in tools, but this library's canonical tool abstraction is currently aimed at custom function tools.

Recommendation:

- parity-first migration should keep scope to custom functions
- built-in OpenAI tools should be a later provider-specific enhancement

### 5. Responses-only models

Moving to Responses makes it easier to support models and tool surfaces that are effectively Responses-first or Responses-only in practice.

Examples from the official model docs include:

- `o1-pro`
- `o3-pro`
- `computer-use-preview`

Recommendation:

- finish transport migration first
- then expand the model registry deliberately instead of mixing both changes into one PR

## Recommended Decision

The migration is complete.

The current target state described in this report is now the implemented state:

- OpenAI adapter uses Responses only
- `store: false` is always explicit
- no OpenAI conversation state is used
- `Conversation` and `SessionApi` remain the state layer
- Chat Completions fallback has been removed

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
