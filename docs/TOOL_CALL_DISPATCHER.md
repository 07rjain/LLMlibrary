# External Tool Call Dispatcher

`Conversation` accepts an optional `toolCallDispatcher` for integrations that need to own tool execution. When configured, tool calls are sent to the dispatcher with the canonical call, resolved model and provider, session ID, and abort signal. Set `toolCallDispatcherMetadata` on the conversation to attach JSON-safe integration metadata to every dispatched call.

The existing inline `CanonicalTool.execute` path remains available when no dispatcher is configured. Strict validation requires every dispatched call to match a registered `CanonicalTool` schema. Use permissive validation only when the dispatcher deliberately owns validation and authorization. The dispatcher is an execution boundary, not a permission or sandbox policy; those decisions remain with the integration.
