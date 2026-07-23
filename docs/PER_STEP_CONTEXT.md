# Per-Step Context Management

Conversation context management is evaluated before the initial model request and before each automatic tool-loop follow-up. The context manager receives the current tool round, request identifier, reserved output capacity, context-window information when configured, and an estimate of tool-schema tokens.

Applications can observe trimming through `ConversationOptions.onCompaction` and persist their own compaction or artifact records.
