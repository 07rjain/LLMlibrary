# LLM API Reference — Anthropic · OpenAI · Google Gemini
> Engineering reference for the raw-fetch adapter layer.
> **Sources:** Anthropic fetched from `platform.claude.com/docs`, OpenAI from `developers.openai.com/api/reference`, Gemini from `ai.google.dev/api/generate-content`. All verified live via Chrome extension, April 2026.

---

## ⚡ Critical Differences at a Glance

| | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| **Endpoint** | `POST /v1/messages` | `POST /v1/chat/completions` | `POST /v1beta/models/{model}:generateContent` |
| **Base URL** | `api.anthropic.com` | `api.openai.com` | `generativelanguage.googleapis.com` |
| **Auth header** | `x-api-key: {key}` | `Authorization: Bearer {key}` | `x-goog-api-key: {key}` |
| **Extra header** | `anthropic-version: 2023-06-01` ✅ **required** | — | — |
| **Streaming** | Same endpoint + `"stream": true` | Same endpoint + `"stream": true` | **Different endpoint:** `:streamGenerateContent?alt=sse` ⚠️ |
| **System prompt** | Top-level `"system"` field | `{role: "system"}` or `{role: "developer"}` message | Top-level `"systemInstruction": {parts:[{text}]}` ⚠️ |
| **Assistant role name** | `"assistant"` | `"assistant"` | `"model"` ⚠️ |
| **Tool args in response** | Object (no parse needed) | **JSON string** — `JSON.parse()` required ⚠️ | Object (no parse needed) |
| **Tool result placement** | `role:"user"` + `tool_result` block | `role:"tool"` message ⚠️ | `role:"user"` + `functionResponse` part ⚠️ |
| **Stop reason: normal** | `"end_turn"` | `"stop"` | `"STOP"` |
| **Stop reason: tool call** | `"tool_use"` | `"tool_calls"` | `"STOP"` — check `parts` for `functionCall` ⚠️ |
| **Usage fields** | `input_tokens` / `output_tokens` | `prompt_tokens` / `completion_tokens` | `promptTokenCount` / `candidatesTokenCount` |
| **Stream sentinel** | No sentinel — connection closes | `data: [DONE]` | No sentinel — connection closes |

---

# 1. ANTHROPIC
> Docs: `https://platform.claude.com/docs/en/api/messages`

## 1.1 Endpoint & Authentication

```
POST https://api.anthropic.com/v1/messages

Required headers:
  x-api-key: YOUR_API_KEY
  anthropic-version: 2023-06-01       ← REQUIRED or you get a 400
  content-type: application/json
```

## 1.2 Request Body — All Parameters

```typescript
{
  // ── REQUIRED ──────────────────────────────────────────────────────
  model: string,           // "claude-sonnet-4-6" | "claude-haiku-4-5" | "claude-opus-4-6"
  max_tokens: number,      // MUST be set — no default. Max output tokens.
  messages: Message[],     // alternating user/assistant turns

  // ── OPTIONAL ──────────────────────────────────────────────────────
  system?: string | ContentBlock[],   // system prompt — NOT a message role
  temperature?: number,    // 0.0–1.0, default 1.0
  top_p?: number,          // 0.0–1.0, nucleus sampling
  top_k?: number,          // top-K sampling
  stop_sequences?: string[],
  stream?: boolean,        // default false
  tools?: Tool[],
  tool_choice?: ToolChoice,
  thinking?: {             // extended thinking
    type: "enabled" | "disabled" | "adaptive",
    budget_tokens?: number // min 1024
  },
  output_config?: {        // structured JSON output
    type: "json_schema",
    schema: object,
    effort?: "low" | "medium" | "high" | "max"
  },
  metadata?: { user_id?: string },
  service_tier?: "auto" | "standard_only"
}
```

## 1.3 Message & Content Block Formats

```typescript
// Message
{ role: "user" | "assistant", content: string | ContentBlock[] }
// Rules: MUST alternate user/assistant. First message MUST be "user".
// "system" is NOT a valid role — use top-level system field.

// Text block
{ type: "text", text: string, cache_control?: { type: "ephemeral", ttl?: "5m" | "1h" } }

// Image block
{
  type: "image",
  source: { type: "base64", media_type: "image/jpeg"|"image/png"|"image/gif"|"image/webp", data: string }
        | { type: "url", url: string }
}

// Document block (PDF support)
{
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: string }
        | { type: "url", url: string }
        | { type: "text", data: string, media_type: "text/plain" },
  title?: string, context?: string,
  citations?: { enabled: boolean }
}

// Tool use block — appears in ASSISTANT message when model calls a tool
{
  type: "tool_use",
  id: string,         // e.g. "toolu_01Abc..."
  name: string,
  input: object       // already a parsed object — NOT a JSON string
}

// Tool result block — appears in USER message when returning result
{
  type: "tool_result",
  tool_use_id: string,    // must match the tool_use.id above
  content: string | ContentBlock[],
  is_error?: boolean
}
```

## 1.4 Tool Definition

```typescript
{
  name: string,
  description: string,
  input_schema: {         // NOTE: "input_schema" not "parameters"
    type: "object",
    properties: { [key]: { type: string, description?: string, enum?: string[] } },
    required?: string[]
  }
}

// Tool choice
{ type: "auto" }          // model decides (default)
{ type: "any" }           // model MUST call a tool
{ type: "none" }          // no tool calls
{ type: "tool", name: string, disable_parallel_tool_use?: boolean }
```

## 1.5 Tool Call Round-Trip

```
Step 1: Send messages + tools
Step 2: Model returns stop_reason: "tool_use" with tool_use blocks in content[]
Step 3: Execute tools
Step 4: Append the full assistant message, then a user message with tool_result blocks
Step 5: Call API again — model generates final answer

// Full conversation after tool execution:
messages: [
  { role: "user",      content: "Is size L in stock?" },
  { role: "assistant", content: [
      { type: "text",     text: "Let me check..." },          // may be present
      { type: "tool_use", id: "toolu_abc", name: "check_stock", input: { sku: "L" } }
  ]},
  { role: "user",      content: [
      { type: "tool_result", tool_use_id: "toolu_abc", content: '{"qty":4}' }
  ]}
]
```

## 1.6 Response Object

```typescript
{
  id: string,                   // "msg_01Abc..."
  type: "message",
  role: "assistant",
  model: string,
  content: ContentBlock[],      // [{type:"text", text:"..."}, ...] or [{type:"tool_use",...}]
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use",
  stop_sequence: string | null,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_creation_input_tokens: number,  // prompt cache write tokens (more expensive)
    cache_read_input_tokens: number       // prompt cache read tokens (cheaper: 10% of input price)
  }
}
```

## 1.7 Streaming — SSE Event Sequence

```
Header: stream: true
Format: "data: {json}\n\n" lines

// Normal text response:
data: {"type":"message_start","message":{"id":"msg_..","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Yes, we have"}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" 4 in stock."}}
data: {"type":"content_block_stop","index":0}
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":14}}
data: {"type":"message_stop"}

// Tool call response:
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"check_stock","input":{}}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"sku\":"}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"hoodie-L\"}"}}
data: {"type":"content_block_stop","index":0}
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":22}}
data: {"type":"message_stop"}

// ⚠️ Tool input arrives as partial JSON strings across deltas — buffer them and JSON.parse() on content_block_stop
```

## 1.8 Error Format & Status Codes

```typescript
// Error body:
{ type: "error", error: { type: string, message: string } }

// Status codes:
// 400  invalid_request_error  — bad request body / missing required field
// 401  authentication_error   — bad or missing x-api-key
// 403  permission_error       — no access to this model
// 429  rate_limit_error       — slow down (check Retry-After header)
// 500  api_error              — Anthropic internal error (retry)
// 529  overloaded_error       — Anthropic overloaded (retry with backoff)
```

## 1.9 Rate Limit Response Headers

```
anthropic-ratelimit-requests-limit: 1000
anthropic-ratelimit-requests-remaining: 999
anthropic-ratelimit-requests-reset: 2026-04-15T10:00:00Z
anthropic-ratelimit-tokens-limit: 80000
anthropic-ratelimit-tokens-remaining: 78500
anthropic-ratelimit-tokens-reset: 2026-04-15T10:00:30Z
retry-after: 30    ← seconds to wait (on 429 only)
```

## 1.10 Current Models

| Model | Context | Speed | Cost tier |
|---|---|---|---|
| `claude-sonnet-4-6` | 200k | Fast | $$$ |
| `claude-haiku-4-5` | 200k | Fastest | $ |
| `claude-opus-4-6` | 200k | Slow | $$$$ |

---

# 2. OPENAI
> Docs: `https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create`

## 2.1 Endpoint & Authentication

```
POST https://api.openai.com/v1/chat/completions

Required headers:
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json

Optional:
  OpenAI-Organization: org-...
  OpenAI-Project: proj-...
```

## 2.2 Request Body — All Parameters

```typescript
{
  // ── REQUIRED ──────────────────────────────────────────────────────
  model: string,          // "gpt-5.4" | "gpt-5.4-mini" | "gpt-4o" | "gpt-4o-mini" | "o3" | "o1"
  messages: Message[],

  // ── OUTPUT CONTROL ────────────────────────────────────────────────
  max_completion_tokens?: number,  // preferred — replaces deprecated max_tokens
  max_tokens?: number,             // DEPRECATED — use max_completion_tokens
  temperature?: number,            // 0–2, default 1 (not supported on o-series)
  top_p?: number,                  // 0–1, nucleus sampling
  n?: number,                      // choices to generate, default 1 (keep at 1 — costs N×)
  stop?: string | string[],        // stop sequences (up to 4)
  presence_penalty?: number,       // -2.0 to 2.0
  frequency_penalty?: number,      // -2.0 to 2.0
  seed?: number,                   // for deterministic outputs (best effort)
  logprobs?: boolean,
  top_logprobs?: number,           // 0–20, requires logprobs: true

  // ── TOOLS ─────────────────────────────────────────────────────────
  tools?: Tool[],
  tool_choice?: "none" | "auto" | "required"
              | { type: "function", function: { name: string } },
  parallel_tool_calls?: boolean,   // default true

  // ── REASONING (o-series models only) ──────────────────────────────
  reasoning_effort?: "low" | "medium" | "high",

  // ── RESPONSE FORMAT ───────────────────────────────────────────────
  response_format?: { type: "text" }
                  | { type: "json_object" }
                  | { type: "json_schema", json_schema: { name: string, schema: object, strict?: boolean } },

  // ── STREAMING ─────────────────────────────────────────────────────
  stream?: boolean,                // default false
  stream_options?: { include_usage: boolean },  // include usage in final stream chunk

  // ── CACHING & IDENTIFICATION ───────────────────────────────────────
  prompt_cache_key?: string,       // replaces deprecated `user` for cache optimisation
  prompt_cache_retention?: "ephemeral" | string,
  user?: string,                   // DEPRECATED — use prompt_cache_key + safety_identifier
  safety_identifier?: string,      // stable user identifier for safety monitoring

  // ── PLATFORM ──────────────────────────────────────────────────────
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority",
  store?: boolean,                 // store output for model distillation / evals
  web_search_options?: object,     // enable web search tool
  metadata?: object,               // key-value pairs attached to the object
  modalities?: string[],           // ["text"] | ["text","audio"]
  verbosity?: string,
}
```

## 2.3 Message Formats

```typescript
// System / Developer instruction
{ role: "system", content: string }
{ role: "developer", content: string }   // ← NEW preferred role for system instructions

// User message — text
{ role: "user", content: string }

// User message — multimodal
{ role: "user", content: [
  { type: "text",      text: string },
  { type: "image_url", image_url: { url: string, detail?: "low"|"high"|"auto" } }
  // url = "https://..." OR "data:image/jpeg;base64,..."
]}

// Assistant message — text
{ role: "assistant", content: string }

// Assistant message — with tool calls (content is null when tool_calls present)
{ role: "assistant", content: null, tool_calls: [{
  id: string,            // "call_abc123"
  type: "function",
  function: {
    name: string,
    arguments: string    // ⚠️ JSON STRING — always JSON.parse() this
  }
}]}

// Tool result — role is "tool" (not "user")
{
  role: "tool",
  tool_call_id: string,  // matches the tool_calls[].id above
  content: string        // result as a string (can be JSON.stringify of an object)
}
```

## 2.4 Tool Definition

```typescript
{
  type: "function",          // always "function"
  function: {
    name: string,            // max 64 chars, pattern: [a-zA-Z0-9_-]+
    description?: string,    // important — model uses this to decide when to call
    parameters?: {           // JSON Schema
      type: "object",
      properties: { [key]: { type: string, description?: string, enum?: any[] } },
      required?: string[],
      additionalProperties?: boolean
    },
    strict?: boolean         // enforce strict JSON Schema (default false)
  }
}
```

## 2.5 Tool Call Round-Trip

```
Step 1: Send messages + tools
Step 2: Response has finish_reason:"tool_calls" and message.tool_calls array
Step 3: JSON.parse() each tool_calls[].function.arguments — it's a JSON string
Step 4: Execute the tools
Step 5: Append the assistant message, then tool result messages (role:"tool")
Step 6: Call API again

// Full conversation after tool execution:
messages: [
  { role: "developer",  content: "You are a store assistant." },
  { role: "user",       content: "Is size L in stock?" },
  { role: "assistant",  content: null,
    tool_calls: [{ id: "call_abc", type: "function",
                   function: { name: "check_stock", arguments: '{"sku":"L"}' } }] },
  { role: "tool",       tool_call_id: "call_abc", content: '{"qty":4}' }
]
```

## 2.6 Response Object

```typescript
{
  id: string,                    // "chatcmpl-abc..."
  object: "chat.completion",
  created: number,               // unix timestamp
  model: string,
  choices: [{
    index: number,
    message: {
      role: "assistant",
      content: string | null,    // null when tool_calls is present
      tool_calls?: [{
        id: string,              // "call_abc123"
        type: "function",
        function: {
          name: string,
          arguments: string      // ⚠️ JSON STRING — JSON.parse() this
        }
      }],
      refusal?: string,
      annotations?: [{           // present when web search tool used
        type: "url_citation",
        url_citation: { url: string, title: string, start_index: number, end_index: number }
      }]
    },
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call",
    logprobs: null | object
  }],
  usage: {
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
    prompt_tokens_details?: {
      cached_tokens: number,     // tokens served from cache (50% cost)
      audio_tokens: number
    },
    completion_tokens_details?: {
      reasoning_tokens: number,  // o-series only — thinking tokens
      audio_tokens: number,
      accepted_prediction_tokens: number,
      rejected_prediction_tokens: number
    }
  },
  service_tier?: string,
  system_fingerprint?: string    // backend config fingerprint
}
```

## 2.7 Streaming — SSE Format

```
Header: stream: true
Lines: "data: {json}\n\n" — ends with "data: [DONE]\n\n"

// Text chunk:
{
  id: "chatcmpl-abc",
  object: "chat.completion.chunk",
  created: 1714000000,
  model: "gpt-5.4",
  choices: [{
    index: 0,
    delta: {
      role: "assistant",    // only in FIRST chunk
      content: " hello"     // text delta — null/absent during tool calls
    },
    finish_reason: null     // null until the last chunk
  }]
}

// Tool call chunk — arguments stream as PARTIAL JSON across multiple chunks:
choices: [{
  delta: {
    tool_calls: [{
      index: 0,             // which tool call (for parallel)
      id: "call_abc",       // only in first chunk for this tool call
      type: "function",     // only in first chunk
      function: {
        name: "check_stock",    // only in first chunk
        arguments: "{\"sku\":"  // PARTIAL — accumulate, then JSON.parse() when done
      }
    }]
  },
  finish_reason: null
}]

// Final chunk (with stream_options: {include_usage: true}):
{ ..., choices: [{delta:{}, finish_reason:"stop"}], usage: { prompt_tokens:25, completion_tokens:14, total_tokens:39 } }

// Sentinel — stream complete:
data: [DONE]
```

## 2.8 Error Format & Status Codes

```typescript
{ error: { message: string, type: string, param: string | null, code: string | null } }

// Status codes:
// 400  invalid_request_error  — bad params / context too long
// 401  authentication_error   — bad API key
// 403  permission_error
// 429  rate_limit_error       — check retry-after header
// 500  server_error           — retry
// 503  service_unavailable    — retry
```

## 2.9 Rate Limit Response Headers

```
x-ratelimit-limit-requests: 5000
x-ratelimit-remaining-requests: 4999
x-ratelimit-reset-requests: 1s          ← time until reset (e.g. "0.5s", "1m30s")
x-ratelimit-limit-tokens: 200000
x-ratelimit-remaining-tokens: 199500
x-ratelimit-reset-tokens: 0.1s
retry-after: 30                          ← seconds (on 429 only)
```

## 2.10 Current Models

| Model | Context | Notes |
|---|---|---|
| `gpt-5.4` | 128k | Latest flagship |
| `gpt-5.4-mini` | 128k | Fast + cheap |
| `gpt-5.4-nano` | 128k | Cheapest |
| `gpt-4o` | 128k | Previous flagship |
| `gpt-4o-mini` | 128k | Previous cheap tier |
| `o3` | 200k | Reasoning model |
| `o1` | 200k | Older reasoning |

---

# 3. GOOGLE GEMINI
> Docs: `https://ai.google.dev/api/generate-content`

## 3.1 Endpoints & Authentication

```
# Standard (waits for full response)
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent

# ⚠️ Streaming — DIFFERENT URL, not just stream:true on same endpoint
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse

Required headers:
  x-goog-api-key: YOUR_API_KEY
  Content-Type: application/json

# Alternative auth (service accounts):
  Authorization: Bearer {access_token}
```

## 3.2 Request Body — All Parameters

```typescript
{
  // ── REQUIRED ──────────────────────────────────────────────────────
  contents: Content[],        // conversation turns

  // ── OPTIONAL ──────────────────────────────────────────────────────
  systemInstruction?: {       // system prompt — a Content object with parts
    parts: [{ text: string }]
    // role field is ignored here
  },
  tools?: Tool[],
  toolConfig?: ToolConfig,
  safetySettings?: SafetySetting[],
  generationConfig?: GenerationConfig,
  cachedContent?: string      // name of cached content resource
}
```

## 3.3 Content & Part Formats

```typescript
// Content object
{
  role: "user" | "model",    // ⚠️ "model" NOT "assistant"
  parts: Part[]
}

// Text part
{ text: string }

// Inline media part (images, audio, video, PDF)
{
  inlineData: {
    mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
             | "audio/mp3" | "audio/wav" | "audio/aac" | "audio/ogg"
             | "video/mp4" | "video/mpeg" | "video/mov"
             | "application/pdf",
    data: string    // base64 encoded
  }
}

// File reference (from Files API)
{ fileData: { mimeType: string, fileUri: string } }

// Function call part — appears in MODEL response
{
  functionCall: {
    name: string,
    args: object    // ⚠️ Already a parsed OBJECT — no JSON.parse needed
  }
}

// Function response part — YOU send this back in a USER turn
{
  functionResponse: {
    name: string,
    response: object    // the result — already an object
  }
}
```

## 3.4 Tool Definition

```typescript
{
  functionDeclarations: [{          // ⚠️ array inside an object
    name: string,
    description: string,
    parameters?: {
      type: "OBJECT",               // ⚠️ UPPERCASE type names
      properties: {
        [key]: {
          type: "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT",
          description?: string,
          enum?: string[],
          items?: object            // for ARRAY type
        }
      },
      required?: string[]
    }
  }]
}

// Tool config
{
  functionCallingConfig: {
    mode: "AUTO" | "ANY" | "NONE",  // AUTO=model decides, ANY=must call, NONE=no calls
    allowedFunctionNames?: string[] // only when mode:"ANY"
  }
}
```

## 3.5 Tool Call Round-Trip

```
Step 1: Send contents + tools
Step 2: Response candidate has parts with a functionCall item
Step 3: args is already an object — NO JSON.parse needed
Step 4: Execute the tool
Step 5: Append the model response, then a USER content with functionResponse part
Step 6: Call API again

// Full conversation after tool execution:
contents: [
  { role: "user",  parts: [{ text: "Is size L in stock?" }] },
  { role: "model", parts: [{ functionCall: { name: "check_stock", args: { sku: "L" } } }] },
  { role: "user",  parts: [{ functionResponse: { name: "check_stock", response: { qty: 4 } } }] }
  // ⚠️ Tool result goes in a USER message — there is no "tool" role in Gemini
]
```

## 3.6 GenerationConfig

```typescript
{
  temperature?: number,          // 0.0–2.0
  topK?: number,
  topP?: number,                 // 0.0–1.0
  candidateCount?: number,       // 1–8, default 1
  maxOutputTokens?: number,
  stopSequences?: string[],      // up to 5
  responseMimeType?: "text/plain" | "application/json",
  responseSchema?: object,       // JSON schema for structured output
  seed?: number,
  frequencyPenalty?: number,
  presencePenalty?: number,
  responseLogprobs?: boolean,
  logprobs?: number              // 0–5
}
```

## 3.7 Response Object

```typescript
{
  candidates: [{
    content: {
      role: "model",
      parts: Part[]    // text parts OR functionCall parts
    },
    finishReason: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION"
                | "LANGUAGE" | "OTHER" | "BLOCKLIST" | "PROHIBITED_CONTENT"
                | "SPII" | "MALFORMED_FUNCTION_CALL",
    index: number,
    safetyRatings: [{
      category: "HARM_CATEGORY_HATE_SPEECH" | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
              | "HARM_CATEGORY_DANGEROUS_CONTENT" | "HARM_CATEGORY_HARASSMENT"
              | "HARM_CATEGORY_CIVIC_INTEGRITY",
      probability: "NEGLIGIBLE" | "LOW" | "MEDIUM" | "HIGH",
      blocked?: boolean
    }],
    citationMetadata?: object,
    tokenCount?: number,
    groundingMetadata?: object
  }],
  usageMetadata: {
    promptTokenCount: number,
    candidatesTokenCount: number,
    totalTokenCount: number,
    cachedContentTokenCount?: number
  },
  modelVersion?: string
}

// ⚠️ CRITICAL: finishReason "STOP" means BOTH normal completion AND tool calls
// To detect tool call: candidates[0].content.parts.some(p => 'functionCall' in p)
```

## 3.8 Streaming — SSE Format

```
Endpoint: :streamGenerateContent?alt=sse
Format: "data: {json}\n\n"
NO [DONE] sentinel — stream ends when HTTP connection closes

// ⚠️ KEY DIFFERENCE from OpenAI/Anthropic:
// Each chunk is a COMPLETE GenerateContentResponse object, not a delta
// Text: concatenate candidates[0].content.parts[0].text across all chunks
// Usage: only accurate in the LAST chunk
// Function calls: arrive as a COMPLETE functionCall object in one chunk (not streamed as fragments)

// Example text chunk:
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "Yes, we have " }] },
    "finishReason": null,
    "index": 0
  }],
  "usageMetadata": { "promptTokenCount": 25, "candidatesTokenCount": 3, "totalTokenCount": 28 }
}

// Final chunk:
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "4 units in stock." }] },
    "finishReason": "STOP",
    "index": 0,
    "safetyRatings": [...]
  }],
  "usageMetadata": { "promptTokenCount": 25, "candidatesTokenCount": 14, "totalTokenCount": 39 }
}
```

## 3.9 Error Format & Status Codes

```typescript
{
  error: {
    code: number,
    message: string,
    status: "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "PERMISSION_DENIED"
          | "NOT_FOUND" | "RESOURCE_EXHAUSTED" | "INTERNAL" | "UNAVAILABLE",
    details?: [{ "@type": string, retryDelay?: string, ... }]
  }
}

// ⚠️ Rate limits: Gemini does NOT use Retry-After headers
// Parse retryDelay from error.details[].retryDelay instead (e.g. "30s")

// Status codes:
// 400  INVALID_ARGUMENT      — bad request
// 401  UNAUTHENTICATED       — bad API key
// 403  PERMISSION_DENIED     — no access to model
// 404  NOT_FOUND
// 429  RESOURCE_EXHAUSTED    — rate limit — check details[].retryDelay
// 500  INTERNAL              — Google internal error (retry)
// 503  UNAVAILABLE           — overloaded (retry)
```

## 3.10 Current Models

| Model | Context | Notes |
|---|---|---|
| `gemini-2.5-pro` | 1M tokens | Most capable |
| `gemini-2.5-flash` | 1M tokens | Best speed/cost balance |
| `gemini-2.5-flash-lite` | 1M tokens | Ultra-cheap |
| `gemini-2.0-flash` | 1M tokens | Previous Flash |
| `gemini-embedding-2` | 8192 (input) | **Embedding only** — NOT a chat model |

---

# 4. CANONICAL FORMAT — Adapter Contract

## 4.1 Canonical Types

```typescript
// Canonical message — what your library uses internally
type CanonicalRole = "system" | "user" | "assistant";

interface CanonicalMessage {
  role: CanonicalRole;
  content: string | CanonicalPart[];
}

type CanonicalPart =
  | { type: "text";        text: string }
  | { type: "image";       data: string; mimeType: string }   // base64
  | { type: "tool_call";   id: string; name: string; args: object }   // ALWAYS parsed object
  | { type: "tool_result"; toolCallId: string; result: unknown; isError?: boolean };

// Canonical response
interface CanonicalResponse {
  text: string | null;
  toolCalls: Array<{ id: string; name: string; args: object }> | null;
  finishReason: "stop" | "length" | "tool_call" | "content_filter" | "error";
  model: string;
  provider: "anthropic" | "openai" | "gemini";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUSD: number;
    cost: string;    // "$0.0023"
  };
  raw: unknown;      // original provider response — for debugging
}
```

## 4.2 Translation Tables

```
ROLE TRANSLATION
────────────────────────────────────────────────────────────────
Canonical "system"    → Anthropic: top-level system field
                      → OpenAI:    { role: "developer", content }
                      → Gemini:    systemInstruction.parts[0].text

Canonical "user"      → Anthropic: { role: "user" }
                      → OpenAI:    { role: "user" }
                      → Gemini:    { role: "user" }

Canonical "assistant" → Anthropic: { role: "assistant" }
                      → OpenAI:    { role: "assistant" }
                      → Gemini:    { role: "model" }   ⚠️


TOOL ARGS NORMALISATION (provider response → canonical)
────────────────────────────────────────────────────────────────
Anthropic  input is already an object          → args: object  ✅
OpenAI     function.arguments is a JSON string → JSON.parse()  ⚠️
Gemini     functionCall.args is already object → args: object  ✅


TOOL RESULT TRANSLATION (canonical → provider)
────────────────────────────────────────────────────────────────
Canonical tool_result → Anthropic:
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] }

Canonical tool_result → OpenAI:
  { role: "tool", tool_call_id: id, content: JSON.stringify(result) }

Canonical tool_result → Gemini:
  { role: "user", parts: [{ functionResponse: { name, response: result } }] }


STOP REASON TRANSLATION (provider → canonical)
────────────────────────────────────────────────────────────────
Anthropic "end_turn"   → "stop"
Anthropic "max_tokens" → "length"
Anthropic "tool_use"   → "tool_call"

OpenAI "stop"          → "stop"
OpenAI "length"        → "length"
OpenAI "tool_calls"    → "tool_call"
OpenAI "content_filter"→ "content_filter"

Gemini "STOP" (no functionCall in parts) → "stop"
Gemini "STOP" (has functionCall in parts)→ "tool_call"  ← check parts!
Gemini "MAX_TOKENS"    → "length"
Gemini "SAFETY"        → "content_filter"


USAGE TRANSLATION (provider → canonical)
────────────────────────────────────────────────────────────────
Anthropic:
  inputTokens  = usage.input_tokens
  outputTokens = usage.output_tokens
  cachedTokens = usage.cache_read_input_tokens

OpenAI:
  inputTokens  = usage.prompt_tokens
  outputTokens = usage.completion_tokens
  cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0

Gemini:
  inputTokens  = usageMetadata.promptTokenCount
  outputTokens = usageMetadata.candidatesTokenCount
  cachedTokens = usageMetadata.cachedContentTokenCount ?? 0
```

---

# 5. ZERO-DEPENDENCY UTILITIES

## 5.1 SSE Parser (works for all 3 providers)

```typescript
async function* parseSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data && data !== "[DONE]") {   // OpenAI sends [DONE], Anthropic/Gemini don't
          yield data;
        }
      }
    }
  }
  // Flush any remaining buffer content
  if (buffer.startsWith("data: ")) {
    const data = buffer.slice(6).trim();
    if (data && data !== "[DONE]") yield data;
  }
}
```

## 5.2 Retry with Backoff

```typescript
async function withRetry<T>(
  fn: () => Promise<Response>,
  opts = { maxAttempts: 3, baseMs: 1000, maxMs: 30_000 }
): Promise<Response> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const res = await fn();

    if (res.ok) return res;

    // Non-retryable
    if ([400, 401, 403, 404].includes(res.status)) return res;

    // Rate limit — use Retry-After if present (Anthropic/OpenAI)
    // or parse retryDelay from Gemini error body
    if (res.status === 429 || res.status >= 500) {
      if (attempt === opts.maxAttempts) return res;

      const retryAfter = res.headers.get("retry-after");
      let waitMs: number;

      if (retryAfter) {
        // Could be seconds (number) or a date
        const parsed = Number(retryAfter);
        waitMs = isNaN(parsed)
          ? new Date(retryAfter).getTime() - Date.now()
          : parsed * 1000;
      } else {
        waitMs = Math.min(opts.baseMs * 2 ** (attempt - 1), opts.maxMs);
      }

      await new Promise(r => setTimeout(r, waitMs + Math.random() * 500));
      continue;
    }

    return res;
  }
  throw new Error("Max retry attempts exceeded");
}
```

## 5.3 Cost Calculation

```typescript
// prices.json — adapt from LiteLLM's MIT-licensed model_prices_and_context_window.json
// Prices in USD per 1,000,000 tokens
const PRICES: Record<string, {
  input: number; output: number;
  cacheRead?: number; cacheWrite?: number;
}> = {
  // Anthropic (April 2026)
  "claude-sonnet-4-6":  { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-haiku-4-5":   { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  "claude-opus-4-6":    { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },

  // OpenAI (April 2026)
  "gpt-5.4":            { input: 2.50,  output: 10.00, cacheRead: 1.25  },
  "gpt-5.4-mini":       { input: 0.40,  output: 1.60,  cacheRead: 0.20  },
  "gpt-5.4-nano":       { input: 0.10,  output: 0.40,  cacheRead: 0.05  },
  "gpt-4o":             { input: 2.50,  output: 10.00, cacheRead: 1.25  },
  "gpt-4o-mini":        { input: 0.15,  output: 0.60,  cacheRead: 0.075 },
  "o3":                 { input: 10.00, output: 40.00, cacheRead: 2.50  },

  // Gemini (April 2026)
  "gemini-2.5-pro":       { input: 1.25,  output: 10.00 },
  "gemini-2.5-flash":     { input: 0.075, output: 0.30  },
  "gemini-2.5-flash-lite":{ input: 0.015, output: 0.06  },
};

function calcCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedReadTokens = 0,
  cachedWriteTokens = 0
): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (inputTokens       / 1_000_000) * p.input       +
    (outputTokens      / 1_000_000) * p.output      +
    (cachedReadTokens  / 1_000_000) * (p.cacheRead  ?? p.input * 0.1) +
    (cachedWriteTokens / 1_000_000) * (p.cacheWrite ?? p.input * 1.25)
  );
}
```

## 5.4 Token Estimation (no dependencies)

```typescript
// Use provider counting APIs for accuracy. This is only for pre-flight estimates.
// Accuracy: ±10% for English, ±20% for code/other languages
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// To get exact counts before a call:
// Anthropic: POST /v1/messages/count_tokens (same body, no stream/max_tokens)
//   → { input_tokens: number }
// OpenAI:    No dedicated endpoint — use tiktoken or estimate
// Gemini:    POST /v1beta/models/{model}:countTokens (same body as generateContent)
//   → { totalTokens: number }
```

---

*Last verified: April 2026 via Chrome extension live browser fetch.*
*Official docs: [Anthropic](https://platform.claude.com/docs/en/api/messages) · [OpenAI](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [Gemini](https://ai.google.dev/api/generate-content)*
