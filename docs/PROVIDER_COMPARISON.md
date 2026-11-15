# Provider Comparison

This library currently ships first-party adapters for Anthropic, OpenAI, and Google Gemini.

## Capability Matrix

| Provider      | Selected seeded completion models                                              | Streaming | Tool calling | Vision inputs | Session persistence                 | Notes                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------ | --------- | ------------ | ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Anthropic     | `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | Yes       | Yes          | Yes           | Via `Conversation` + session stores | Native thinking modes and effort depend on the model. Cache read/write pricing is modeled separately.                 |
| OpenAI        | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`                    | Yes       | Yes          | Yes           | Via `Conversation` + session stores | Uses the stateless Responses API with `store: false`. Reasoning effort and sampling restrictions depend on the model. |
| Google Gemini | `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash`   | Yes       | Yes          | Yes           | Via `Conversation` + session stores | Streaming uses `streamGenerateContent`. Gemini 4 uses implicit caching and thinking levels rather than token budgets. |

These are selected checked-in models, not the provider's full live catalog. See
[the model catalog](./MODEL_CATALOG.md) for pricing, lifecycle changes, and older
models. Use `client.models.listRemote({ provider })` for discovery against the
provider's broader model list; discovery does not add adapter capabilities.

## Translation Differences

### Switching response features

The following table describes this library's adapter coverage. Provider API
availability alone does not mean a feature is exposed by this library.

| Feature                                  | OpenAI                        | Anthropic                                                 | Google Gemini          |
| ---------------------------------------- | ----------------------------- | --------------------------------------------------------- | ---------------------- |
| Canonical PDF input                      | Yes, vision models            | Yes, vision models                                        | Yes, vision models     |
| Explicit response verbosity              | Compatible GPT-5/GPT-6 models | No equivalent mapping                                     | No equivalent mapping  |
| Canonical `reasoningSummary` field       | Compatible reasoning models   | Not exposed                                               | Not exposed            |
| Reasoning stream events                  | Requested provider summaries  | Thinking blocks not exposed as canonical reasoning events | Requested thought text |
| Native reasoning controls                | `openai.reasoning`            | `anthropic.thinking` / `effort`                           | `google.thinking`      |
| Canonical video input                    | Not implemented               | Not implemented                                           | Not implemented        |
| Canonical token probabilities / logprobs | Not implemented               | Not implemented                                           | Not implemented        |

Use `client.models.getResponseCapabilities(modelId)` to inspect PDF, verbosity,
and canonical summary support for a resolved registered model. Reusing OpenAI
verbosity/reasoning settings on an incompatible model fails clearly by default.
Set `providerOptions.unsupportedFeaturePolicy: 'omit'` to explicitly drop those
unsupported controls on that attempt. PDF content remains intact and must be
supported by the selected model. See [model switching](./OPENAI_RESPONSES_FEATURES.md#switching-models-and-providers)
for fallback and persistence behavior. Token probabilities describe token
likelihood, not the factual correctness of an answer, and are separate from reasoning.

### Wire formats

| Concern                | Anthropic                          | OpenAI                                               | Gemini                                 |
| ---------------------- | ---------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| System prompt handling | Lifted into `system` blocks        | Flattened into top-level `instructions`              | Lifted into `systemInstruction`        |
| Assistant role name    | `assistant`                        | `assistant`                                          | `model`                                |
| Tool call payload      | `tool_use` blocks                  | `function_call.arguments` JSON string with `call_id` | `functionCall.args` object             |
| Tool result payload    | `tool_result` block in a user turn | `function_call_output` item keyed by `call_id`       | `functionResponse` part in a user turn |
| Streaming terminator   | SSE close / `message_stop`         | `response.completed` / stream close                  | SSE close on dedicated stream endpoint |

## Choosing a Provider

- Choose OpenAI when you want Responses-first model coverage, automatic prompt caching on supported models, and the broadest ecosystem compatibility.
- Choose Anthropic when long-context tool workflows or prompt caching behavior are central to the workload.
- Choose Gemini when you need a single provider surface that is comfortable with mixed text, vision, document, and audio inputs.

## Operational Notes

- All three adapters normalize token usage into a shared `UsageMetrics` shape and estimate cost from the model registry.
- All three adapters map auth, rate-limit, context-window, and generic provider failures into typed `LLMError` subclasses.
- OpenAI and Gemini cached-read usage is priced separately from uncached input when the provider returns cached-token counts. OpenAI cached-write counts are also normalized and priced separately when returned.
- Live-provider smoke tests can be executed with `LIVE_TESTS=1 pnpm test:live` after populating `.env`.
- Deeper real-service integration checks can be executed with `pnpm test:real:providers` or `pnpm test:real` after populating `.env`. These are intentionally opt-in because they consume provider quota and can fail for account-state reasons such as Anthropic low credits or Gemini rate limits.
