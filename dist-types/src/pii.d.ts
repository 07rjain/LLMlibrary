import type { CanonicalMessage, JsonValue } from './types.js';
export type PIIRedactionKind = 'credit_card' | 'email' | 'phone';
export interface PIIRedactionOptions {
    kinds?: readonly PIIRedactionKind[];
    phone?: {
        maxDigits?: number;
        minDigits?: number;
    };
    replacements?: Partial<Record<PIIRedactionKind, string>>;
    validateCreditCards?: boolean;
}
export interface PIIRedactionOccurrence {
    end: number;
    kind: PIIRedactionKind;
    path?: string;
    replacement: string;
    start: number;
}
export interface PIIRedactionSummary {
    byKind: Record<PIIRedactionKind, number>;
    occurrences: PIIRedactionOccurrence[];
    total: number;
}
export interface PIIRedactionResult {
    summary: PIIRedactionSummary;
    text: string;
}
export interface JsonPIIRedactionResult {
    summary: PIIRedactionSummary;
    value: JsonValue;
}
export interface MessagePIIRedactionResult {
    messages: CanonicalMessage[];
    summary: PIIRedactionSummary;
}
/**
 * Redacts common PII patterns without returning the matched values in metadata.
 * Pattern matching is best-effort and is not a substitute for a compliance DLP.
 */
export declare function redactPII(text: string, options?: PIIRedactionOptions): PIIRedactionResult;
/** Recursively redacts strings in JSON-compatible tool inputs and outputs. */
export declare function redactPIIInJson(value: JsonValue, options?: PIIRedactionOptions): JsonPIIRedactionResult;
/**
 * Returns cloned messages with text, tool-call arguments, and tool results
 * redacted. Binary data and URL/document parts are left unchanged.
 */
export declare function redactPIIFromMessages(messages: readonly CanonicalMessage[], options?: PIIRedactionOptions): MessagePIIRedactionResult;
//# sourceMappingURL=pii.d.ts.map