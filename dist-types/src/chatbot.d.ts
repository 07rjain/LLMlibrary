import type { LLMRequestOptions } from './client.js';
import type { FormatRetrievedContextOptions, FormattedRetrievedContext, RetrievalCitation, RetrievalQuery, RetrievalResult, Retriever } from './retrieval.js';
import type { CanonicalMessage, CanonicalResponse } from './types.js';
export type RetrievalScopeField = 'botId' | 'embeddingProfileId' | 'knowledgeSpaceId' | 'scopeType' | 'scopeUserId' | 'tenantId';
export type UngroundedAnswerAction = 'fallback' | 'return';
export interface CompletionInvoker {
    complete(options: LLMRequestOptions): Promise<CanonicalResponse>;
}
export interface CitationValidationResult {
    invalidOrdinals: number[];
    missingRequiredCitations: boolean;
    referencedOrdinals: number[];
    valid: boolean;
}
export interface GroundingCheckInput {
    citationValidation: CitationValidationResult;
    context: FormattedRetrievedContext;
    question: string;
    response: CanonicalResponse;
    results: RetrievalResult[];
}
export interface GroundingCheckResult {
    reason?: string;
    score?: number;
    supported: boolean;
}
export type GroundingCheck = (input: GroundingCheckInput) => GroundingCheckResult | Promise<GroundingCheckResult>;
export interface GroundedPromptInput {
    context: FormattedRetrievedContext;
    history: CanonicalMessage[];
    question: string;
}
export interface RetrieveAndCompleteOptions {
    allowUnscopedRetrieval?: boolean;
    buildMessages?: (input: GroundedPromptInput) => CanonicalMessage[];
    client: CompletionInvoker;
    fallbackText?: string;
    formatContext?: FormatRetrievedContextOptions;
    groundingCheck?: GroundingCheck;
    onUngrounded?: UngroundedAnswerAction;
    question: string;
    request?: Omit<LLMRequestOptions, 'messages'> & {
        messages?: CanonicalMessage[];
    };
    requireCitations?: boolean;
    requiredScopeFields?: RetrievalScopeField[];
    retrieval?: Omit<RetrievalQuery, 'query'>;
    retriever: Retriever;
    systemInstruction?: string;
}
export type RetrieveAndCompleteStatus = 'answered' | 'no_results' | 'ungrounded';
export interface RetrieveAndCompleteResult {
    citationValidation: CitationValidationResult;
    citations: RetrievalCitation[];
    context: FormattedRetrievedContext;
    grounding?: GroundingCheckResult;
    response?: CanonicalResponse;
    results: RetrievalResult[];
    status: RetrieveAndCompleteStatus;
    text: string;
}
/**
 * Performs explicit retrieval before generation and returns structured
 * citations alongside the answer. Multi-tenant scope is required by default.
 */
export declare function retrieveAndComplete(options: RetrieveAndCompleteOptions): Promise<RetrieveAndCompleteResult>;
/** Builds the default prompt while keeping retrieval context clearly delimited. */
export declare function buildGroundedMessages(input: GroundedPromptInput): CanonicalMessage[];
/** Validates bracketed citation ordinals without claiming semantic grounding. */
export declare function validateCitationReferences(text: string, citationCount: number, requireCitations?: boolean): CitationValidationResult;
//# sourceMappingURL=chatbot.d.ts.map