# Current Models, Pricing, And Retirements

Verified **November 15, 2026** against official API documentation. The built-in
registry has 48 IDs, including aliases and dated variants. This update adds 12
chat models and `gpt-transcribe`. Documentation verification and simulated
transport tests do not establish availability for a particular provider account.

## New Chat Models

Standard on-demand/global prices in **USD per million tokens**:

| Provider  | Model               |   Context | Input | Output | Cache read | Cache write |
| --------- | ------------------- | --------: | ----: | -----: | ---------: | ----------: |
| OpenAI    | `gpt-6-astra`       | 1,050,000 |   $10 |    $50 |         $1 |      $12.50 |
| OpenAI    | `gpt-6.1-sol`       | 1,050,000 |    $2 |    $10 |      $0.10 |       $2.50 |
| OpenAI    | `gpt-6.1-terra`     | 1,050,000 |    $1 |     $5 |      $0.05 |       $1.25 |
| OpenAI    | `gpt-6-luna`        | 1,050,000 | $0.10 |  $0.50 |      $0.01 |      $0.125 |
| Anthropic | `claude-fable-5-2`  | 1,000,000 |    $8 |    $40 |      $0.20 |         $10 |
| Anthropic | `claude-opus-5-5`   | 1,000,000 |    $4 |    $20 |      $0.20 |          $5 |
| Anthropic | `claude-sonnet-5-5` | 1,000,000 |    $2 |    $10 |      $0.10 |       $2.50 |
| Anthropic | `claude-haiku-5-5`  | 1,000,000 | $0.10 |  $0.50 |      $0.01 |      $0.125 |
| Google    | `gemini-4-carbon`   | 1,048,576 |    $2 |    $10 |      $0.10 |           — |
| Google    | `gemini-4-argon`    | 1,048,576 |    $2 |    $10 |      $0.10 |           — |
| Google    | `gemini-4-hydrogen` | 1,048,576 | $1.50 |  $7.50 |     $0.075 |           — |
| Google    | `gemini-3.8-flash`  | 1,048,576 | $0.75 |  $3.75 |     $0.075 |           — |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
and [Google pricing](https://ai.google.dev/gemini-api/docs/pricing). Every seeded
entry includes `pricingSource` and `lastUpdated` for maintenance.

All new chat models use the existing completion and streaming APIs, with tool
calling, image input, and structured-output metadata. Provider-hosted tools,
Realtime, background generation, and outputs beyond the existing synchronous
request surface are not added by registering a model.

The cache-write column uses **30-minute OpenAI retention** and **5-minute
Anthropic retention**. Longer retention has different provider rates; aggregate
cache-write usage is still priced at the baseline retention rate. Cache storage,
hosted tools, regional premiums, and Batch/Flex/Fast modes are not included in
these estimates. Google embedding prices remain a text baseline; image/audio/video
embedding rates differ. See [cost semantics](./COST_AND_PRICING.md).

## Pricing Boundaries

`ModelRegistry.get()` and `client.models.list()` return rates effective on the
registry clock, applying complete `priceChanges` cards at midnight UTC:

| Model                                  | Effective date   | New input / output / cache-read rates |
| -------------------------------------- | ---------------- | ------------------------------------- |
| `gemini-4-carbon`, `gemini-4-argon`    | December 1, 2026 | $4 / $20 / $0.20                      |
| `gemini-3.6-flash`, `gemini-3.8-flash` | January 1, 2027  | $1.50 / $7.50 / $0.15                 |

`gpt-5.6-sol` and its `gpt-5.6` alias use the documented $4 input / $20 output
promotional rates through November 30, 2026. The checked source does not publish
successor rates. Their `pricingExpiresAt` is December 1: dispatch and cost
estimates fail closed after that date until verified pricing is updated. The
registry still exposes their metadata through `get()` for inspection. To keep
completion requests running without using unverified rates, configure a
`ModelRouter` fallback to a model you have tested and priced separately. The
client does not migrate these IDs automatically.

Prompt-length tiers apply to the **entire request**, with a strict `>` boundary:

- GPT-6 models and the seeded GPT-5.4/5.5/5.6 large-context models: over 272,000
  prompt tokens uses 2× input/cache rates and 1.5× output rates.
- `claude-haiku-5-5`: over 100,000 prompt tokens uses 5× input/output/cache rates.
  Cache reads and cache writes count toward the threshold.
- `gemini-2.5-pro` and `gemini-3.1-pro-preview`: over 200,000 prompt tokens uses
  2× input/cache rates and 1.5× output rates.

`calcCostUSD()`, normalized provider usage, and completion budget quotes all use
these tiers. OpenAI/Google total prompt tokens already include cached tokens;
Anthropic reports cache counts separately. The calculation accounts for this
difference and includes separately billed Gemini reasoning output.

For runtime overrides on a scheduled model, pass `priceChanges: []` to replace
the schedule with a newly verified flat rate, or supply a replacement schedule.
For an expired offer, also set a newly verified `pricingExpiresAt` date or
re-register the model without an expiration. Updating a base rate alone does not
remove existing schedules or expiration metadata.

## Retirements And Redirects

Deprecated IDs remain registered until their documented shutdown dates. At a
confirmed shutdown, requests fail before provider dispatch with
`ProviderCapabilityError` and `details.code: 'model_retired'`. They are not
silently upgraded to a model with different behavior. `get()`/`list()` retain
metadata for migration and historical inspection; `isSupported()` on a registry
continues to mean registered, not currently available.

| Registered models                                                                                                            | Date / behavior                                                            | Recommended replacement                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `o3`                                                                                                                         | Shutdown December 11, 2026                                                 | `gpt-6.1-sol`                                                |
| `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`                                                         | Shutdown January 6, 2027                                                   | `gpt-realtime-2.1-mini`; separate Realtime adapter required  |
| `gpt-4o`, `gpt-4o-mini`                                                                                                      | Shutdown January 14, 2027                                                  | `gpt-6-luna`                                                 |
| `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-transcribe-2025-12-15`, `gpt-4o-transcribe-diarize` | Shutdown February 26, 2027                                                 | `gpt-transcribe` for ordinary files; evaluate feature parity |
| `gpt-5.4-nano`                                                                                                               | Shutdown April 1, 2027                                                     | `gpt-6-luna`                                                 |
| `gemini-3.1-flash-lite`                                                                                                      | Earliest possible shutdown May 7, 2027; advisory, not an enforced deadline | `gemini-3.5-flash-lite`                                      |

Google’s documented redirects resolve to the target **before** routing metadata,
budget quotes, provider dispatch, response normalization, and usage logging:

| Original ID        | Redirect date                     | Actual target           |
| ------------------ | --------------------------------- | ----------------------- |
| `gemini-3.5-flash` | Already effective (July 21, 2026) | `gemini-3.6-flash`      |
| `gemini-2.5-pro`   | December 1, 2026                  | `gemini-3.8-flash`      |
| `gemini-2.5-flash` | December 1, 2026                  | `gemini-3.5-flash-lite` |

These endpoints remain available; the date is not an API rejection. Effective
target prices replace the original model’s prices. Google limits 2.5 API access
to existing users; `gemini-2.5-flash-lite` is explicitly not deprecated.

All seeded Claude models remain active. Anthropic’s “not sooner than” dates are
availability guarantees, not retirement deadlines, and are not encoded as
shutdown dates. No currently seeded ID was already fully retired as of this
verification date.

Sources: [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations),
[Anthropic lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
and [Google deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

Inspect lifecycle information or resolve an alias:

```ts
const metadata = client.models.get('gemini-2.5-pro');
console.log(metadata.lifecycle);
const effective = client.models.resolve('gemini-2.5-pro');
console.log(effective.id, effective.inputPrice);
```

Custom registries can use the same lifecycle metadata. Redirects must preserve
provider and model kind and point to a registered ID. Missing targets, cycles,
and incompatible redirects fail before dispatch.

## Compatibility And Audio Migration

- **GPT-6:** Astra and GPT-6.1 Sol reject reasoning effort `none`; use `low` or
  higher. Terra and Luna support `none`. `minimal` is unsupported on the new
  GPT-6 entries. Sampling parameters require explicit `none` on a compatible
  model. Existing calls continue through the Responses API.
- **Claude:** All four additions support `low`, `medium`, `high`, `xhigh`, and
  `max` effort. Fable 5.2 and Opus 5.5 keep adaptive thinking on. Sonnet 5.5
  accepts `between_tools` at `high` effort or below; Haiku 5.5 accepts `disabled`
  at `high` or below. The adapter rejects incompatible modes before dispatch.
- **Gemini 4:** Carbon and Argon accept `low`, `medium`, and `high`; Hydrogen also
  accepts `xhigh`. Explicit context caches and token thinking budgets are not
  supported. The adapter omits obsolete sampling parameters. The 1M context is
  shared by input, thinking, and output; background/long-decode APIs are not
  implemented here.
- **File transcription:** `transcribe()` now defaults to `gpt-transcribe`, priced
  at **$0.0045/minute** ($0.000075/second). It uses the existing file upload
  endpoint. Public `language` is translated to `languages[]`; JSON is the normal
  response. Legacy diarization, timestamp, sampling, speaker, and chunking
  options are rejected for this model rather than forwarded. Pin a compatible
  legacy model for those features until its shutdown, and test the replacement
  separately. The provider does not publish a token context window for
  `gpt-transcribe`, so it is omitted; completion/embedding metadata still requires
  a positive context window.
- **Speech:** `speak()` keeps its existing batch endpoint and deprecated default
  until shutdown. OpenAI’s recommended replacement uses Realtime. No Realtime-only
  models are advertised as working through `speak()` or `transcribe()`.

Sources: [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart),
[Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort),
[Gemini 4 migration](https://ai.google.dev/gemini-api/docs/whats-new-gemini-4-hydrogen),
and [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text).
