# Reasoning Efforts Report

Date: 2026-06-20

## Executive Summary

The library does not currently expose a reasoning-effort or thinking control for completions, streaming, conversations, or the Session API. The only request-level generation controls in the canonical surface are `maxTokens`, `temperature`, tools, and `providerOptions`. Provider-specific request options currently cover prompt caching, not reasoning.

We should add reasoning support, but not as a single over-simplified `reasoningEffort` string only. OpenAI, Anthropic, and Gemini expose overlapping but materially different controls:

- OpenAI: `reasoning: { effort, summary }` on the Responses API, with model-dependent effort values.
- Anthropic: `thinking` blocks, manual `budget_tokens` on some Claude models, newer adaptive thinking plus effort on newer Claude models, and `display` controls for summarized vs omitted thinking.
- Gemini: `generationConfig.thinkingConfig`, using `thinkingLevel` for Gemini 3+ and `thinkingBudget` for Gemini 2.5; thought summaries are opt-in with `includeThoughts`.

Recommended implementation after re-check:

1. Add exact provider-specific controls first:
   - `providerOptions.openai.reasoning`
   - `providerOptions.anthropic.thinking`
   - `providerOptions.anthropic.effort`
   - `providerOptions.google.thinking`
2. Do not add a top-level canonical `reasoning.effort` in the first implementation PR. It is tempting, but it will either be misleading or full of model-specific caveats.
3. Add a canonical convenience layer only after provider-specific request-body support is tested and documented.
4. Track reasoning/thinking token counts in usage metrics in the same PR as request-body support, because otherwise users cannot understand the cost impact.
5. Keep reasoning summaries/thought summaries out of `response.text` by default. Expose them later through explicit metadata or new content-part types.

## Recheck Findings

The initial report was directionally correct, but it needed sharper boundaries:

- It was too optimistic about adding a canonical `reasoning` field first. Provider-specific support is the safer first slice.
- It mentioned specific Anthropic model generations too heavily. Anthropic's model support matrix is changing quickly, so implementation should avoid hardcoding broad model-name behavior unless backed by registry capabilities.
- It did not analyze enough current repo touchpoints: `UsageMetrics`, `Conversation`, Session API, stream chunks, and provider usage normalizers all need attention.
- It did not clearly separate three concerns:
  1. request controls,
  2. token/cost accounting,
  3. reasoning-summary output exposure.

Those should be separate implementation decisions.

## Current Library State

Relevant current code:

- `src/client.ts` defines `LLMRequestOptions` without `reasoning` or `reasoningEffort`.
- `src/types.ts` defines `ProviderOptions` with only:
  - `openai.promptCaching`
  - `anthropic.cacheControl`
  - `google.promptCaching`
- `src/providers/openai.ts` already uses the Responses API and maps `maxTokens` to `max_output_tokens`, but does not send `reasoning`.
- `src/providers/anthropic.ts` builds Messages API bodies and supports `cache_control`, but does not send `thinking` or effort.
- `src/providers/gemini.ts` builds `generationConfig` for `temperature` and `maxOutputTokens`, but does not send `thinkingConfig`.
- `src/utils/cost.ts` maps provider usage into `UsageMetrics`, but `UsageMetrics` has no `reasoningTokens`, `thinkingTokens`, or `thoughtsTokens` field.
- `openaiUsageToCanonical()` does not read `output_tokens_details.reasoning_tokens`.
- `geminiUsageToCanonical()` does not read `usageMetadata.thoughtsTokenCount`.
- `anthropicUsageToCanonical()` has no thinking-token-specific field. Anthropic currently reports total output tokens; thinking-specific handling should be verified against the Messages API response shape before adding a separate field.
- `test/openai.adapter.test.ts` has an existing test that ignores OpenAI `reasoning` output items for text parity. That is good for current behavior, but it means reasoning summaries will need intentional parsing if we expose them.
- `test/prompt_caching_test_droid/live-all-providers.test.ts` already notes that `gemini-2.5-flash` consumes reasoning tokens before visible output, so the repo has already hit this behavior operationally.

Current architecture implication:

- `providerOptions` is already the repo's pattern for provider-specific features like prompt caching. Reasoning controls should use the same path first.
- `LLMRequestOptions` already flows to `complete()` and `stream()`, so adapter-level request support is straightforward.
- `Conversation` stores request defaults such as model, provider, max tokens, tools, and provider options. If reasoning defaults are added, they must be persisted in `ConversationSnapshot` or only allowed per `send()`.
- Session API accepts request payloads and creates conversations. If reasoning controls are exposed over HTTP, the request parser, config shape, and tests must be updated together.
- `StreamChunk` has no place for reasoning summaries today. Streaming thought summaries should not be squeezed into `text-delta`.

## Provider Research

Primary sources used:

- OpenAI reasoning models guide: <https://developers.openai.com/api/docs/guides/reasoning>
- Anthropic extended thinking guide: <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- Gemini thinking guide: <https://ai.google.dev/gemini-api/docs/thinking>

### OpenAI

Official docs: <https://developers.openai.com/api/docs/guides/reasoning>

OpenAI reasoning models use hidden reasoning tokens before and between visible output tokens. The `reasoning.effort` parameter guides how much the model should think. Supported values are model-dependent and can include:

- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

Lower effort favors speed and lower token usage; higher effort improves reasoning quality at higher latency and cost. Defaults are model-dependent, not universal.

Important OpenAI details:

- Reasoning tokens are not visible via the API, but occupy context and are billed as output tokens.
- If `max_output_tokens` is too low, a response can become incomplete before any visible output appears.
- OpenAI recommends reserving substantial output budget when experimenting with reasoning models.
- Reasoning summaries require explicit opt-in through `reasoning.summary`.
- Raw reasoning tokens are not exposed.
- With Responses API function calling, OpenAI recommends preserving reasoning items across turns. For stateless mode, `include: ["reasoning.encrypted_content"]` can return encrypted reasoning content for later continuation.
- The usage object can include reasoning-token counts under output token details. The current library does not expose those counts.

Current impact on this repo:

- The OpenAI adapter uses stateless Responses API calls and currently discards `reasoning` output items. That is fine for visible text parity, but if we add reasoning continuity for tool calls, we need a separate design for storing encrypted reasoning items inside conversation state.

Recommended OpenAI request mapping for first implementation:

```ts
const reasoning = options.providerOptions?.openai?.reasoning;

if (reasoning) {
  body.reasoning = {
    effort: reasoning.effort,
    summary: reasoning.summary,
  };
}
```

Do not emit undefined fields:

```ts
body.reasoning = {
  ...(reasoning.effort ? { effort: reasoning.effort } : {}),
  ...(reasoning.summary ? { summary: reasoning.summary } : {}),
};
```

Also support:

```ts
body.include = ['reasoning.encrypted_content'];
```

but only behind an explicit provider option, because storing encrypted reasoning items changes conversation persistence semantics.

OpenAI implementation details:

- Add `OpenAIReasoningOptions` to `src/types.ts`.
- Add `reasoning?: OpenAIReasoningOptions` to `OpenAIProviderOptions`.
- Update `translateOpenAIRequest()` only; do not change response parsing in the first request-control PR.
- Extend `OpenAIUsagePayload` with:

```ts
output_tokens_details?: {
  reasoning_tokens?: number;
};
completion_tokens_details?: {
  reasoning_tokens?: number;
};
```

- Add `reasoningTokens?: number` to canonical usage if we want to expose it across providers.
- Preserve the existing behavior that reasoning output items do not become user-visible text.

### Anthropic

Official docs: <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>

Anthropic exposes "extended thinking" through a `thinking` object in Messages API requests. Behavior differs by model generation:

- Some current Claude models support manual extended thinking with `thinking: { type: "enabled", budget_tokens: N }`.
- `budget_tokens` must be less than `max_tokens`.
- Some newer Claude models do not support manual extended thinking; use adaptive thinking and the effort parameter instead.
- Some current models still support manual mode, but Anthropic docs recommend adaptive thinking for newer generations and warn that manual mode is deprecated in places.
- `display` controls whether thinking is summarized or omitted.
- Omitted thinking can improve time-to-first-text-token when streaming, but does not reduce billing.
- Anthropic returns `thinking` content blocks and signatures. Multi-turn usage requires preserving signatures when replaying thinking blocks.

Current impact on this repo:

- The Anthropic adapter currently translates content blocks into canonical text, tool use, image, document, and tool result blocks. It has no `thinking` content block type.
- We can pass `thinking` request config safely before we parse thinking response content.
- If we expose thinking summaries later, we need canonical representation for summarized thinking blocks or response metadata.

Recommended Anthropic request mapping for first implementation:

```ts
body.thinking = providerOptions.anthropic.thinking;
body.effort = providerOptions.anthropic.effort;
```

Provider-specific type should closely mirror Anthropic's API and use API field names at the boundary:

```ts
export interface AnthropicThinkingOptions {
  type: 'enabled' | 'adaptive' | 'disabled';
  budgetTokens?: number;
  display?: 'summarized' | 'omitted';
}
```

Adapter translation:

```ts
function translateAnthropicThinking(thinking: AnthropicThinkingOptions) {
  return {
    type: thinking.type,
    ...(thinking.budgetTokens !== undefined
      ? { budget_tokens: thinking.budgetTokens }
      : {}),
    ...(thinking.display ? { display: thinking.display } : {}),
  };
}
```

Do not blindly map canonical `reasoning.effort` to every Anthropic model because:

- manual `budget_tokens` is not accepted by all models,
- adaptive thinking may already be on,
- `thinking: { type: "disabled" }` may be invalid for some models,
- `effort` is coupled to adaptive thinking rather than manual budget mode.

Anthropic implementation details:

- Add provider-specific request support first.
- Validate `budgetTokens < maxTokens` only when `thinking.type === 'enabled'` and `maxTokens` is set.
- Do not parse `thinking` response blocks into normal `text`.
- Do not persist thinking signatures in conversation history in the first PR unless we also design canonical thinking content blocks.
- Add a docs warning that tool-use plus interleaved thinking has special budget semantics.

### Gemini

Official docs: <https://ai.google.dev/gemini-api/docs/thinking>

Gemini thinking is controlled through `generationConfig.thinkingConfig`.

Gemini 3+:

- Uses `thinkingLevel`.
- Supported values vary by model, but documented levels include `minimal`, `low`, `medium`, and `high`.
- `minimal` is not a strict thinking-off guarantee.
- Some Gemini 3 models cannot fully disable thinking.

Gemini 2.5:

- Uses `thinkingBudget`.
- `thinkingBudget: 0` disables thinking on models that support disabling.
- `thinkingBudget: -1` enables dynamic thinking.
- Model-specific ranges differ. For example, Gemini 2.5 Flash supports `0` to `24576`; Gemini 2.5 Pro supports `128` to `32768` and cannot disable thinking.

Thought summaries:

- Set `includeThoughts: true` to receive thought summaries.
- Summary parts are marked with a `thought` boolean.
- Thinking tokens are billed even though summaries are what the API returns.
- `usageMetadata.thoughtsTokenCount` reports generated thinking tokens.
- Thought signatures matter for multi-turn REST/function-calling usage and should be preserved if the app modifies conversation history.
- Gemini docs explicitly say thinking features are supported on all Gemini 3 and 2.5 series models, but controls differ by family.

Current impact on this repo:

- `src/providers/gemini.ts` currently maps `temperature` and `maxTokens` into `generationConfig`.
- Adding `thinkingConfig` is straightforward for basic requests.
- Parsing thought-summary parts needs care so they do not get merged into normal answer text.

Recommended Gemini request mapping for first implementation:

```ts
body.generationConfig = {
  ...generationConfig,
  thinkingConfig: {
    thinkingLevel: providerOptions.google.thinking?.level,
    thinkingBudget: providerOptions.google.thinking?.budgetTokens,
    includeThoughts: providerOptions.google.thinking?.includeThoughts,
  },
};
```

For canonical `reasoning.effort`, map:

- `minimal`, `low`, `medium`, `high` to Gemini 3 `thinkingLevel`.
- For Gemini 2.5 models, either do not map effort automatically or map through a documented local table with clear warnings. A string effort does not translate cleanly to a numeric token budget.

Gemini implementation details:

- Add `thinking?: GoogleThinkingOptions` to `GoogleProviderOptions`.
- In `translateGeminiRequest()`, merge `thinkingConfig` into the existing `generationConfig` object.
- Do not allow both `level` and `budgetTokens` silently if the model family is known. Prefer provider-specific exact options, but warn or throw when the user sends contradictory fields.
- Extend `GeminiUsagePayload` with `thoughtsTokenCount?: number`.
- Decide whether `UsageMetrics.outputTokens` should remain visible answer tokens only or include thought tokens. Current `outputTokens` maps `candidatesTokenCount`, so adding `thinkingTokens` separately is the least surprising path.

## Proposed Public API

Possible common app-level intent for a later PR:

```ts
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface ReasoningOptions {
  effort?: ReasoningEffort;
  summary?: 'none' | 'auto';
}

export interface LLMRequestOptions {
  reasoning?: ReasoningOptions;
}
```

Then add provider-specific exact controls:

```ts
export interface OpenAIReasoningOptions {
  effort?: ReasoningEffort;
  summary?: 'auto' | 'concise' | 'detailed';
  includeEncryptedContent?: boolean;
}

export interface AnthropicThinkingOptions {
  type: 'enabled' | 'adaptive' | 'disabled';
  budgetTokens?: number;
  display?: 'summarized' | 'omitted';
}

export interface AnthropicProviderOptions {
  cacheControl?: CacheControl;
  effort?: Exclude<ReasoningEffort, 'none' | 'minimal' | 'xhigh'>;
  thinking?: AnthropicThinkingOptions;
}

export interface GoogleThinkingOptions {
  level?: 'minimal' | 'low' | 'medium' | 'high';
  budgetTokens?: number;
  includeThoughts?: boolean;
}

export interface GoogleProviderOptions {
  promptCaching?: GooglePromptCachingOptions;
  thinking?: GoogleThinkingOptions;
}
```

Open questions before implementing canonical mapping:

- Whether Anthropic's public `effort` accepted values exactly match `low | medium | high` or have additional values for newer models. Verify against the Messages API reference before implementation.
- Whether to include OpenAI-only `xhigh` in the canonical type or keep it under `OpenAIReasoningOptions` only.
- Whether top-level `reasoning.summary` should map to OpenAI summaries, Anthropic `display: "summarized"`, and Gemini `includeThoughts`, or whether those are too semantically different.
- Whether "off" should exist canonically. It is not portable: Gemini 3 uses `minimal`, Gemini 2.5 Pro cannot disable thinking, and some Claude models reject disabling.

## Why Both Canonical And Provider-Specific Options

A top-level `reasoning.effort` is useful for product code:

```ts
await client.complete({
  model: 'gpt-5.5',
  provider: 'openai',
  reasoning: { effort: 'medium' },
  messages,
});
```

But provider-specific controls are necessary because:

- OpenAI has `summary` and encrypted reasoning continuity.
- Anthropic has `thinking.type`, `budget_tokens`, `display`, and model-specific adaptive/manual differences.
- Gemini has both `thinkingLevel` and `thinkingBudget`, depending on model family.
- "Disable thinking" is not portable. OpenAI may accept `none`; Gemini 3 `minimal` is not guaranteed off; Gemini 2.5 Pro cannot disable thinking; some Claude models cannot disable adaptive thinking.

## Implementation Plan

1. Add provider-specific types in `src/types.ts`
   - `OpenAIReasoningOptions`
   - `AnthropicThinkingOptions`
   - `GoogleThinkingOptions`
   - `UsageMetrics.reasoningTokens?: number`
   - `UsageMetrics.thinkingTokens?: number` or just one canonical `reasoningTokens`

2. Thread provider-specific settings through existing paths
   - `LLMRequestOptions.providerOptions` already flows through `LLMClient.complete()` and `stream()`.
   - `Conversation` already persists `providerOptions`, so provider-specific reasoning can inherit through existing config without adding a new top-level snapshot field.
   - Session API request parsing should allow `providerOptions` if it already does; add explicit tests for reasoning propagation.

3. OpenAI adapter
   - Add `reasoning` to the Responses API body.
   - Add optional `include: ['reasoning.encrypted_content']` only when requested.
   - Keep current default of ignoring reasoning output items in `text`.
   - Map `output_tokens_details.reasoning_tokens` to canonical usage.
   - Add tests asserting exact JSON body.

4. Anthropic adapter
   - Add provider-specific `thinking` body support.
   - Validate `budgetTokens < maxTokens` locally when manual thinking is requested.
   - Do not guess model-specific support beyond simple validation; let provider return 400 for unsupported model/mode unless we add registry capabilities later.

5. Gemini adapter
   - Add `generationConfig.thinkingConfig`.
   - Support exact provider-specific `budgetTokens`, `level`, and `includeThoughts`.
   - Preserve `maxOutputTokens` behavior and document that reasoning/thinking tokens consume budget.
   - Map `usageMetadata.thoughtsTokenCount` to canonical usage.

6. Usage metadata follow-up
   - OpenAI does not currently map reasoning tokens; extend `openaiUsageToCanonical()`.
   - Gemini should map `usageMetadata.thoughtsTokenCount`.
   - Anthropic should map thinking output tokens if exposed separately.
   - Keep `costUSD` calculation unchanged unless provider pricing separates reasoning/thinking tokens from normal output tokens.

7. Docs and examples
   - Add a "Reasoning controls" section to completions docs.
   - Include provider examples and the non-portability warning.
   - Mention that higher reasoning effort increases latency and cost.

8. Tests
   - Unit tests for OpenAI request body.
   - Unit tests for Anthropic request body and `budgetTokens < maxTokens`.
   - Unit tests for Gemini `thinkingConfig`.
   - Unit tests for OpenAI and Gemini reasoning/thinking token usage mapping.
   - Conversation inheritance tests proving `providerOptions` are retained.
   - Session API propagation tests proving HTTP payloads reach `SessionApi` conversations.

## Detailed Test Matrix

OpenAI:

- `translateOpenAIRequest()` adds `reasoning.effort`.
- `translateOpenAIRequest()` adds `reasoning.summary`.
- `translateOpenAIRequest()` omits `reasoning` entirely when no reasoning options are supplied.
- `translateOpenAIRequest()` adds `include: ['reasoning.encrypted_content']` only when requested.
- `openaiUsageToCanonical()` maps `output_tokens_details.reasoning_tokens`.
- Existing reasoning output item test still proves reasoning items are not merged into visible `text`.

Anthropic:

- `translateAnthropicRequest()` maps `{ type: 'enabled', budgetTokens: 1024 }` to `{ type: 'enabled', budget_tokens: 1024 }`.
- `translateAnthropicRequest()` passes `display: 'summarized' | 'omitted'`.
- `translateAnthropicRequest()` passes `effort` only when explicitly set.
- Manual thinking with `budgetTokens >= maxTokens` throws a local validation error.
- No thinking fields are emitted when no options are supplied.

Gemini:

- `translateGeminiRequest()` merges `thinkingConfig` with existing `maxOutputTokens` and `temperature`.
- `level` maps to `thinkingLevel`.
- `budgetTokens` maps to `thinkingBudget`.
- `includeThoughts` maps to `includeThoughts`.
- `geminiUsageToCanonical()` maps `thoughtsTokenCount`.
- Thought summary parts are not merged into normal `text` unless an explicit response-shape change is made.

Conversation and Session API:

- `conversation({ providerOptions: ... })` persists reasoning provider options in snapshots.
- `conversation.send({ providerOptions: ... })` overrides conversation defaults for a single request if that pattern exists.
- Session API create/message requests propagate provider reasoning options to the underlying conversation/client call.

## Recommended First Implementation Slice

Keep the first PR small:

1. Add provider-specific request controls only:
   - `providerOptions.openai.reasoning`
   - `providerOptions.anthropic.thinking`
   - `providerOptions.anthropic.effort`
   - `providerOptions.google.thinking`
2. Add usage-token fields and provider usage mapping for OpenAI/Gemini.
3. Add adapter tests proving request bodies and usage mapping.
4. Add docs.

Then add canonical `reasoning.effort` as a second PR after deciding exact cross-provider mapping policy. This avoids shipping a misleading abstraction while still unblocking users who already know their provider/model.

## Non-Goals For The First PR

- Do not expose raw chain-of-thought.
- Do not merge OpenAI reasoning summaries, Anthropic thinking summaries, or Gemini thought summaries into `response.text`.
- Do not implement encrypted reasoning state replay yet.
- Do not preserve Anthropic thinking signatures or Gemini thought signatures in canonical conversation history yet.
- Do not add model-registry validation for every provider/model reasoning mode.
- Do not add top-level canonical `reasoning.effort` until provider-specific support is stable.

## Risks

- A single `reasoningEffort` can imply portability that does not exist.
- Reasoning tokens consume output/context budget and can produce empty visible output when budgets are too low.
- Some models reject certain thinking modes; model-specific validation will age quickly.
- Preserving encrypted reasoning items or thought signatures changes conversation-state semantics and should not be mixed into the first minimal request-body PR.
- Exposing thought summaries in `text` would break current canonical response expectations; summaries should be separate metadata/content if added.
- Usage accounting can become misleading if `reasoningTokens` are not exposed. Users will see higher costs without a clear reason.
- Streaming summaries need a new chunk type if exposed. Reusing `text-delta` would make the final answer noisy and potentially leak internal diagnostic text to end users.

## Conclusion

Yes, we should add reasoning controls. The best fit for this library is provider-specific support first, plus usage accounting, tests, and docs. A canonical effort layer can come later, but only if it is explicitly documented as best-effort intent rather than a portable guarantee.

The immediate implementation should be:

```ts
await client.complete({
  provider: 'openai',
  model: 'gpt-5.5',
  providerOptions: {
    openai: {
      reasoning: { effort: 'medium', summary: 'auto' },
    },
  },
  messages,
});
```

```ts
await client.complete({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  maxTokens: 4096,
  providerOptions: {
    anthropic: {
      thinking: { type: 'adaptive', display: 'omitted' },
      effort: 'medium',
    },
  },
  messages,
});
```

```ts
await client.complete({
  provider: 'google',
  model: 'gemini-3-pro',
  providerOptions: {
    google: {
      thinking: { level: 'low', includeThoughts: false },
    },
  },
  messages,
});
```

That gives users real control now while keeping the abstraction honest.
