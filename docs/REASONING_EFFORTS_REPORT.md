# Reasoning Efforts Report

Date: 2026-06-20

## Executive Summary

The library does not currently expose a reasoning-effort or thinking control for completions, streaming, conversations, or the Session API. The only request-level generation controls in the canonical surface are `maxTokens`, `temperature`, tools, and `providerOptions`. Provider-specific request options currently cover prompt caching, not reasoning.

We should add reasoning support, but not as a single over-simplified `reasoningEffort` string only. OpenAI, Anthropic, and Gemini expose overlapping but materially different controls:

- OpenAI: `reasoning: { effort, summary }` on the Responses API, with model-dependent effort values.
- Anthropic: `thinking` blocks, manual `budget_tokens` on some Claude models, newer adaptive thinking plus effort on newer Claude models, and `display` controls for summarized vs omitted thinking.
- Gemini: `generationConfig.thinkingConfig`, using `thinkingLevel` for Gemini 3+ and `thinkingBudget` for Gemini 2.5; thought summaries are opt-in with `includeThoughts`.

Recommended implementation:

1. Add a small canonical `reasoning` option for common app-level intent.
2. Add exact provider-specific `providerOptions.openai.reasoning`, `providerOptions.anthropic.thinking`, and `providerOptions.google.thinking` escape hatches.
3. Keep summaries/thought text out of `response.text` by default, but expose summarized reasoning as metadata/content parts in a follow-up change if needed.
4. Add adapter tests first, because these fields are easy to silently drop.

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
- `test/openai.adapter.test.ts` has an existing test that ignores OpenAI `reasoning` output items for text parity. That is good for current behavior, but it means reasoning summaries will need intentional parsing if we expose them.
- `test/prompt_caching_test_droid/live-all-providers.test.ts` already notes that `gemini-2.5-flash` consumes reasoning tokens before visible output, so the repo has already hit this behavior operationally.

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

Current impact on this repo:

- The OpenAI adapter uses stateless Responses API calls and currently discards `reasoning` output items. That is fine for visible text parity, but if we add reasoning continuity for tool calls, we need a separate design for storing encrypted reasoning items inside conversation state.

Recommended OpenAI request mapping:

```ts
body.reasoning = {
  effort: options.reasoning?.effort ?? options.providerOptions?.openai?.reasoning?.effort,
  summary: options.providerOptions?.openai?.reasoning?.summary,
};
```

Also support:

```ts
body.include = ['reasoning.encrypted_content'];
```

but only behind an explicit provider option, because storing encrypted reasoning items changes conversation persistence semantics.

### Anthropic

Official docs: <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>

Anthropic exposes "extended thinking" through a `thinking` object in Messages API requests. Behavior differs by model generation:

- Some current Claude models support manual extended thinking with `thinking: { type: "enabled", budget_tokens: N }`.
- `budget_tokens` must be less than `max_tokens`.
- Claude Opus 4.8 and 4.7 do not support manual extended thinking; use `thinking: { type: "adaptive" }` plus the effort parameter.
- Claude Fable 5 and Claude Mythos 5 always have adaptive thinking enabled; manual extended thinking is not supported.
- Claude Opus 4.6 and Sonnet 4.6 still support manual mode, but Anthropic recommends adaptive thinking and says manual mode is deprecated for these models.
- `display` controls whether thinking is summarized or omitted.
- Omitted thinking can improve time-to-first-text-token when streaming, but does not reduce billing.

Current impact on this repo:

- The Anthropic adapter currently translates content blocks into canonical text, tool use, image, document, and tool result blocks. It has no `thinking` content block type.
- We can pass `thinking` request config safely before we parse thinking response content.
- If we expose thinking summaries later, we need canonical representation for summarized thinking blocks or response metadata.

Recommended Anthropic request mapping:

```ts
body.thinking = providerOptions.anthropic.thinking;
body.effort = providerOptions.anthropic.effort;
```

For canonical `reasoning.effort`, map only when the Anthropic model/config supports adaptive thinking:

```ts
body.thinking = { type: 'adaptive', display: 'omitted' };
body.effort = options.reasoning.effort;
```

Do not blindly map `reasoning.budgetTokens` to every Anthropic model because newer models reject manual `budget_tokens`.

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

Current impact on this repo:

- `src/providers/gemini.ts` currently maps `temperature` and `maxTokens` into `generationConfig`.
- Adding `thinkingConfig` is straightforward for basic requests.
- Parsing thought-summary parts needs care so they do not get merged into normal answer text.

Recommended Gemini request mapping:

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

## Proposed Public API

Add common app-level intent:

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

Open question: whether Anthropic's public `effort` accepted values exactly match `low | medium | high` or have additional values for Claude 5-era models. Verify against the Messages API reference before implementation.

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

1. Add types in `src/types.ts`
   - `ReasoningEffort`
   - `ReasoningOptions`
   - OpenAI/Anthropic/Google provider-specific reasoning types
   - `LLMRequestOptions.reasoning`

2. Thread through client and conversations
   - `LLMRequestOptions` already flows through `LLMClient.complete()` and `stream()`.
   - Add `reasoning?: ReasoningOptions` to `ConversationOptions`, `ConversationSendOptions`, and `ConversationConfig` if persistent conversations should inherit a default.
   - Add Session API request support if users can submit reasoning settings over HTTP.

3. OpenAI adapter
   - Add `reasoning` to the Responses API body.
   - Merge canonical and provider-specific settings with provider-specific taking precedence.
   - Add optional `include: ['reasoning.encrypted_content']` only when requested.
   - Keep current default of ignoring reasoning output items in `text`.
   - Add tests asserting exact JSON body.

4. Anthropic adapter
   - Add provider-specific `thinking` body support.
   - Add adaptive mapping for canonical `reasoning.effort` only when the caller has not supplied explicit `providerOptions.anthropic.thinking`.
   - Validate `budgetTokens < maxTokens` locally when manual thinking is requested.
   - Do not guess model-specific support beyond simple validation; let provider return 400 for unsupported model/mode unless we add registry capabilities later.

5. Gemini adapter
   - Add `generationConfig.thinkingConfig`.
   - Map canonical `minimal | low | medium | high` to `thinkingLevel` for Gemini 3-like model names.
   - Support exact provider-specific `budgetTokens`, `level`, and `includeThoughts`.
   - Preserve `maxOutputTokens` behavior and document that reasoning/thinking tokens consume budget.

6. Usage metadata follow-up
   - OpenAI already maps reasoning tokens if present in provider usage only if `openaiUsageToCanonical` supports the field; verify and extend if needed.
   - Add `reasoningTokens` or `thinkingTokens` to `UsageMetrics` if not already present.
   - Gemini should map `usageMetadata.thoughtsTokenCount`.
   - Anthropic should map thinking output tokens if exposed separately.

7. Docs and examples
   - Add a "Reasoning controls" section to completions docs.
   - Include provider examples and the non-portability warning.
   - Mention that higher reasoning effort increases latency and cost.

8. Tests
   - Unit tests for OpenAI request body.
   - Unit tests for Anthropic request body and `budgetTokens < maxTokens`.
   - Unit tests for Gemini `thinkingConfig`.
   - Conversation inheritance tests.
   - Session API propagation tests if HTTP support is added.

## Recommended First Implementation Slice

Keep the first PR small:

1. Add provider-specific request controls only:
   - `providerOptions.openai.reasoning`
   - `providerOptions.anthropic.thinking`
   - `providerOptions.anthropic.effort`
   - `providerOptions.google.thinking`
2. Add adapter tests proving request bodies.
3. Add docs.

Then add canonical `reasoning.effort` as a second PR after deciding exact cross-provider mapping policy. This avoids shipping a misleading abstraction while still unblocking users who already know their provider/model.

## Risks

- A single `reasoningEffort` can imply portability that does not exist.
- Reasoning tokens consume output/context budget and can produce empty visible output when budgets are too low.
- Some models reject certain thinking modes; model-specific validation will age quickly.
- Preserving encrypted reasoning items or thought signatures changes conversation-state semantics and should not be mixed into the first minimal request-body PR.
- Exposing thought summaries in `text` would break current canonical response expectations; summaries should be separate metadata/content if added.

## Conclusion

Yes, we should add reasoning controls. The best fit for this library is provider-specific support first, plus a carefully documented canonical effort layer later. That matches the existing `providerOptions` pattern, avoids false portability, and lets users access current OpenAI, Anthropic, and Gemini reasoning controls without waiting for a perfect cross-provider abstraction.
