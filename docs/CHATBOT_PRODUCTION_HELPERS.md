# Chatbot Production Helpers

This guide covers the optional orchestration and data-hygiene helpers intended
for public chatbot widgets. They compose the existing client, retrieval, and
Session API surfaces; they do not turn the core client into a hosted chatbot
platform.

## Retrieve, Ground, And Cite

`retrieveAndComplete()` runs retrieval before generation, formats retrieved
chunks as untrusted context, and returns the answer and citations together.

```ts
import { LLMClient } from 'unified-llm-client';
import { retrieveAndComplete } from 'unified-llm-client/chatbot';
import { createDenseRetriever } from 'unified-llm-client/retrieval';

const client = LLMClient.fromEnv({
  defaultEmbeddingModel: 'gemini-embedding-2',
  defaultModel: 'gpt-4o-mini',
});
const retriever = createDenseRetriever({
  embed: client,
  store: knowledgeStore,
});

const answer = await retrieveAndComplete({
  client,
  formatContext: { maxResults: 4, maxTokens: 900 },
  question: 'What is the refund window?',
  request: {
    maxTokens: 400,
    tenantId: authenticatedTenant.id,
  },
  retrieval: {
    filter: {
      botId: bot.id,
      embeddingProfileId: bot.embeddingProfileId,
      knowledgeSpaceId: bot.knowledgeSpaceId,
      tenantId: authenticatedTenant.id,
    },
    topK: 8,
  },
  retriever,
});

return Response.json({
  citations: answer.citations,
  status: answer.status,
  text: answer.text,
});
```

By default, all four scope fields must be present:

- `tenantId`
- `botId`
- `knowledgeSpaceId`
- `embeddingProfileId`

The values must come from authenticated server-side state, not directly from
widget input. A single-tenant prototype can explicitly set
`allowUnscopedRetrieval: true`; production multi-tenant applications should not.
The helper copies `tenantId` and `botId` from the retrieval filter into the
completion request for usage attribution, and rejects conflicting request values.
For user-private knowledge, add `scopeType` and `scopeUserId` to
`requiredScopeFields`.

When retrieval returns nothing, the helper returns `status: 'no_results'` and
does not call the model. When the model omits citations or cites an ordinal that
was not supplied, it returns `status: 'ungrounded'` and the configured fallback
text. Set `onUngrounded: 'return'` only when the application has a separate
review path for unsupported output.

### Citation Validation Is Not Fact Checking

The built-in validator confirms that bracketed citation ordinals such as `[1]`
refer to supplied chunks. It does not prove that a claim is semantically
supported. Add a reranker, NLI model, or application evaluator through
`groundingCheck` when that distinction matters:

```ts
const answer = await retrieveAndComplete({
  client,
  groundingCheck: async ({ context, response }) => {
    const evaluation = await evaluateSupport(response.text, context.text);
    return {
      reason: evaluation.reason,
      score: evaluation.score,
      supported: evaluation.score >= 0.8,
    };
  },
  question,
  retrieval,
  retriever,
});
```

Retrieved text is delimited and the default system instruction tells the model
to treat it as data, not instructions. That reduces prompt-injection risk but
does not replace source allowlists, ingestion-time sanitization, narrow tools,
or output policy checks.

## Redact Transcript PII

The PII helpers redact common emails, phone numbers, and Luhn-valid payment-card
numbers. Result metadata contains kinds, counts, paths, and offsets, but never
the matched value.

```ts
import { redactPII, redactPIIFromMessages } from 'unified-llm-client/pii';

const transcript = redactPII(
  'Email customer@example.com or call +1 415 555 2671.',
);
console.log(transcript.text);
// Email [REDACTED_EMAIL] or call [REDACTED_PHONE].

const safeMessages = redactPIIFromMessages(messages);
await analytics.write({
  messages: safeMessages.messages,
  redactionCounts: safeMessages.summary.byKind,
});
```

`redactPIIFromMessages()` clones messages and redacts plain text, text parts,
tool-call arguments, and tool results. It intentionally does not inspect base64
media, document payloads, URLs, arbitrary message metadata, or JSON object keys.
Keep object keys schema-controlled; unusual keys are represented by numeric
placeholders in redaction paths so metadata does not echo them.

Pattern redaction is best-effort. It can produce false positives and negatives,
so use a dedicated DLP provider when regulation, contractual controls, or broad
identifier coverage requires it. Minimize collection first, encrypt retained
transcripts, define retention windows, and keep deletion paths tenant-scoped.

## Put The Session API Behind A Gateway

`createSessionApi()` supplies framework-agnostic session routes, trusted-context
tenant isolation, policy-override controls, and tool-result redaction. The host
application remains responsible for the public HTTP boundary.

```ts
import { createSessionApi } from 'unified-llm-client/session-api';

const sessionApi = createSessionApi({
  allowClientOverrides: false,
  client,
  conversationDefaults: {
    maxTokens: 500,
    maxToolRounds: 3,
    system: trustedSystemPrompt,
    toolValidation: 'strict',
  },
  exposeToolResults: false,
  middleware: [
    async (request) => {
      const principal = await authenticateWidgetRequest(request);
      if (!principal) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const allowed = await rateLimiter.consume(
        `${principal.tenantId}:${principal.widgetId}`,
      );
      if (!allowed) {
        return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
      }

      return {
        tenantId: principal.tenantId,
        userId: principal.userId,
        widgetId: principal.widgetId,
      };
    },
  ],
  sessionStore,
  tenantResolution: 'trusted-context',
});

export async function handleWidgetRequest(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins.has(origin)) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  }

  const contentLengthHeader = request.headers.get('content-length');
  const contentLength = Number(contentLengthHeader);
  if (
    request.body &&
    (!contentLengthHeader ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > 64 * 1024)
  ) {
    return Response.json({ error: 'Request too large' }, { status: 413 });
  }

  return sessionApi.handle(request);
}
```

The Session API forwards `request.signal` to both streamed and non-streamed
model work, so a platform that aborts the request on disconnect can stop the
provider call. The gateway should additionally enforce:

- cryptographic widget or user authentication; never trust body/query tenant ids
- an exact origin allowlist and appropriate CORS response headers
- per-IP and per-tenant request rates plus concurrent-generation limits
- request body, message length, history, output-token, tool-round, and spend caps
- moderation or abuse policy before expensive retrieval/model calls
- request ids and structured metrics without raw prompts or tool payloads
- a reverse-proxy/runtime timeout that aborts its `Request` signal
- CSRF protection when browser credentials are cookie-based

## What Still Belongs Outside This Module

These helpers intentionally do not provide a universal authentication system,
distributed rate limiter, moderation provider, semantic grounding model,
transcript vault, or browser widget UI. Those choices depend on deployment,
identity, compliance, and product requirements. Keep them in the application or
in separate adapters instead of embedding one vendor into the core client.
