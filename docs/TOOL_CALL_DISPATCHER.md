# External Tool Call Dispatcher

`Conversation` accepts an optional `toolCallDispatcher` for integrations that need to own tool execution. When configured, tool calls are sent to the dispatcher with the canonical call, resolved model and provider, session ID, abort signal, and JSON-safe metadata.

The existing inline `CanonicalTool.execute` path remains available when no dispatcher is configured. The dispatcher is an execution boundary, not a permission or sandbox policy; those decisions remain with the integration.
