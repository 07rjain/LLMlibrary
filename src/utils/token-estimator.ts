import type { CanonicalMessage, CanonicalPart } from '../types.js';

export interface AnthropicCountTokensOptions {
  apiKey: string;
  body: Record<string, unknown>;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
  url?: string;
}

export interface GeminiCountTokensOptions {
  apiKey: string;
  body: Record<string, unknown>;
  fetchImplementation?: typeof fetch;
  model: string;
  signal?: AbortSignal;
  url?: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(messages: CanonicalMessage[]): number {
  return messages.reduce((total, message) => {
    return total + estimateMessageContentTokens(message.content) + 4;
  }, 0);
}

export async function anthropicCountTokens(
  options: AnthropicCountTokensOptions,
): Promise<number> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    options.url ?? 'https://api.anthropic.com/v1/messages/count_tokens',
    buildRequestInit(
      {
      body: JSON.stringify(options.body),
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
      },
      method: 'POST',
      },
      options.signal,
    ),
  );

  if (!response.ok) {
    throw new Error(`Anthropic token count request failed with ${response.status}.`);
  }

  const body = (await response.json()) as { input_tokens?: number };
  return body.input_tokens ?? 0;
}

export async function geminiCountTokens(
  options: GeminiCountTokensOptions,
): Promise<number> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl =
    options.url ??
    `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:countTokens`;
  const response = await fetchImplementation(
    baseUrl,
    buildRequestInit(
      {
        body: JSON.stringify(options.body),
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': options.apiKey,
        },
        method: 'POST',
      },
      options.signal,
    ),
  );

  if (!response.ok) {
    throw new Error(`Gemini token count request failed with ${response.status}.`);
  }

  const body = (await response.json()) as { totalTokens?: number };
  return body.totalTokens ?? 0;
}

function estimateMessageContentTokens(content: CanonicalMessage['content']): number {
  if (typeof content === 'string') {
    return estimateTokens(content);
  }

  return content.reduce((total, part) => total + estimatePartTokens(part), 0);
}

function estimatePartTokens(part: CanonicalPart): number {
  switch (part.type) {
    case 'audio':
      return estimateTokens(part.url ?? part.data ?? '');
    case 'document':
      return estimateTokens(part.title ?? '') + estimateTokens(part.url ?? part.data ?? '');
    case 'image_base64':
      return estimateTokens(part.data);
    case 'image_url':
      return estimateTokens(part.url);
    case 'text':
      return estimateTokens(part.text);
    case 'tool_call':
      return estimateTokens(`${part.name}${JSON.stringify(part.args)}`);
    case 'tool_result':
      return estimateTokens(
        `${part.name ?? ''}${part.toolCallId}${JSON.stringify(part.result)}`,
      );
  }
}

function buildRequestInit(
  init: Omit<RequestInit, 'signal'>,
  signal: AbortSignal | undefined,
): RequestInit {
  if (!signal) {
    return init;
  }

  return {
    ...init,
    signal,
  };
}
