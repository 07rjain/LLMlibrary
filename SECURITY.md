# Security Policy

## Supported Versions

Security fixes are provided for the latest published `unified-llm-client`
release and the current `main` branch.

This repository is currently pre-1.0. Until a formal long-term support policy is
published, older minor versions are not guaranteed to receive security patches.
Consumers should upgrade to the latest release when security fixes are shipped.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through the GitHub repository:

- Repository: https://github.com/07rjain/LLMlibrary
- Preferred channel: GitHub private vulnerability reporting, if enabled
- Fallback: open a GitHub issue that does not include exploit details, secrets,
  customer data, or working attack payloads

Include:

- Affected version or commit
- Affected package entry point or file
- Preconditions and attacker-controlled input
- Expected and observed behavior
- Minimal reproduction steps, when safe to share

Do not include real API keys, database credentials, tenant data, model outputs
containing private data, or production logs with sensitive values.

## Security Boundary

`unified-llm-client` is a provider-agnostic LLM client library. It provides
canonical request/response types, provider adapters, tool calling, conversation
state, session persistence helpers, retrieval helpers, and a framework-agnostic
Session API handler.

The library treats these as supported security boundaries:

- Server-supplied policy fields such as `system`, `model`, `provider`,
  `providerOptions`, `responseFormat`, `budgetUsd`, `toolValidation`,
  `maxToolRounds`, and `toolExecutionTimeoutMs`
- Trusted tenant context supplied by application middleware
- Session snapshots loaded from configured `SessionStore` implementations
- Tool schemas and strict tool argument validation before executable tools run
- Request abort/cancellation signals that should stop provider and tool work
- Tenant-scoped persistence and retrieval operations when `tenantId` is supplied

The library does not provide built-in end-user authentication. Applications that
mount `createSessionApi()` on a network route must authenticate requests and
resolve tenant identity before calling the handler.

## Trusted And Untrusted Inputs

Treat these inputs as untrusted unless the consuming application has already
authenticated and authorized them:

- HTTP request bodies, query parameters, and headers
- `sessionId` values supplied by clients
- Request-supplied `tenantId` values
- User messages and multimodal content
- Model-generated tool calls and tool arguments
- Uploaded documents and retrieval metadata
- URLs forwarded to providers for multimodal or file processing
- Session snapshots imported from external systems or user-controlled stores

Treat these inputs as trusted operator or developer configuration:

- API keys and provider credentials loaded from server-side environment
  variables
- Server-side `conversationDefaults`
- Registered executable tools
- Tool implementations and their authorization logic
- `contextManager` and `withRequestContext` callbacks
- Session store clients and database connection configuration
- Agent instruction files and skills loaded from application-controlled
  filesystem locations

If an application lets untrusted users configure tools, tool schemas, agent
instructions, filesystem roots, database connectors, or provider options, that
application must add its own authorization and sandboxing controls.

## Session API Responsibilities

The Session API is framework-agnostic and can be mounted in Express, Fastify,
Hono, Next.js, Cloudflare Workers, or similar runtimes. When it is exposed to
clients, the consuming application is responsible for:

- Authenticating every request
- Resolving `tenantId` in trusted middleware
- Keeping `tenantResolution: "trusted-context"` for public or multi-tenant
  deployments
- Passing only explicitly allowed client overrides through
  `allowClientOverrides`
- Applying rate limits, concurrency limits, and request size limits
- Enforcing CORS and origin policy appropriate for the deployment
- Ensuring session ids are scoped to the authenticated tenant

Request-supplied `tenantId` values are rejected by default. The
`legacy-request-tenant` mode is a compatibility mode for non-public or already
authenticated integrations, not a public multi-tenant default.

## Session Snapshot Trust

Session snapshots should be treated as persisted conversation state, not as
authoritative policy unless the application explicitly trusts the snapshot
source.

On restore, server policy should take precedence over stale, imported, or
client-influenced snapshot fields. Applications should pass current trusted
policy when restoring conversations and should avoid importing snapshots from
untrusted sources without validation.

Snapshot stores should be protected with normal data-store controls:

- Tenant scoping in keys or composite database constraints
- Database row-level security where applicable
- Write access limited to trusted server code
- Validation before importing or migrating snapshot JSON

## Tool Calling

Executable tools run in the application process and may access databases,
network services, files, or other privileged resources. The library validates
tool arguments when `toolValidation` is strict, but tool implementations remain
responsible for their own authorization and safety checks.

Tool implementations should:

- Authorize every action using trusted tenant and user context
- Treat model-generated arguments as untrusted
- Use read-only database credentials for read-only tools
- Use parameterized queries and structured APIs
- Enforce per-tool timeouts and result size limits
- Avoid returning secrets or raw internal errors to the model
- Check `AbortSignal` and stop work when aborted

Do not rely on prompt instructions as the only authorization boundary for tools.

## Provider And Network Behavior

Provider adapters forward canonical messages and content to the selected LLM
provider. Providers may fetch remote URLs included in multimodal content.
Applications that accept untrusted URLs should enforce their own URL policy,
such as allowlists, private-network blocking, file size limits, and content-type
checks before sending data to providers.

API keys must remain server-side. Browser or widget clients should call a
server-controlled API with a scoped public key or authenticated session, never a
provider API key.

## Retrieval And Multi-Tenancy

Retrieval stores and search requests must be scoped by trusted tenant and bot
context. Applications should pass tenant identifiers from authenticated
middleware, not from untrusted request bodies.

For multi-tenant deployments, use defense in depth:

- Database constraints or composite keys including tenant id
- Row-level security where available
- Parameterized queries
- Separate API keys or credentials where appropriate
- Audit logs for ingestion, deletion, and search operations

## Out Of Scope

The following are outside the library's default security boundary unless a
consuming application explicitly exposes them to untrusted users:

- Local development scripts and benchmarks
- Tests, fixtures, and generated coverage artifacts
- Documentation examples
- Consumer-supplied tool code
- Consumer-supplied authentication, billing, and tenant middleware
- Provider-side model behavior and provider infrastructure
- Untrusted execution of arbitrary agent skills or local filesystem content

## Security Checklist For Integrators

Before exposing this library in a production service:

- Mount `createSessionApi()` behind authentication middleware
- Resolve tenant identity from trusted auth context
- Keep client override allowlists minimal
- Set explicit budgets, tool round limits, and tool execution timeouts
- Register only tools that perform their own authorization
- Scope session and retrieval storage by tenant
- Redact secrets from logs and model-visible tool results
- Enforce request size, rate, and concurrency limits
- Propagate `AbortSignal` to provider, retrieval, and tool work
- Keep dependencies and provider model pricing metadata current

## Security Scan Archives

Repository security audits and sealed evidence live under `security_scan/`.

- Human findings report: `security_scan/cursor_security_scan_report.md`
- Archive index: `security_scan/archives/README.md`
- Latest full evidence release:
  https://github.com/07rjain/LLMlibrary/releases/tag/security-scan-20260709
- Tarball:
  https://github.com/07rjain/LLMlibrary/releases/download/security-scan-20260709/ee9e5c6_20260709T114052Z.tar.gz
- SHA-256:
  `9a3649f1f4be3751fde5ef3affa80248e0e02d97b31d897d2c4d275eac510233`

Agent guidance also points here from `CLAUDE.md` and `AGENTS.md`.
