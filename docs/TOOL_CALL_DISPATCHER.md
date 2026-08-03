# External Tool Call Dispatcher

`Conversation` accepts an optional `toolCallDispatcher` for integrations that need to own tool execution. When configured, tool calls are sent to the dispatcher with the canonical call, resolved model and provider, session ID, and abort signal. Set `toolCallDispatcherMetadata` on the conversation to attach JSON-safe integration metadata to every dispatched call.

The dispatcher is validated when the conversation is constructed. It must be a
non-array object with an own data property named `execute` whose value is a
function; invalid values fail immediately with a typed capability error before
any provider, tool, store, or callback work occurs. When restoring or resuming
a conversation, pass the dispatcher and its metadata again in the restore
options; they are runtime integrations and are not persisted in snapshots.

The existing inline `CanonicalTool.execute` path remains available when no dispatcher is configured. Strict validation requires every dispatched call to match a registered `CanonicalTool` schema. Use permissive validation only when the dispatcher deliberately owns validation and authorization. The dispatcher is an execution boundary, not a permission or sandbox policy; those decisions remain with the integration.
