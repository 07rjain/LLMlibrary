import { ProviderCapabilityError } from 'unified-llm-client/errors';
import {
  assertProviderArray,
  assertProviderObject,
  assertProviderString,
  invalidProviderResponse,
} from '../provider-response.js';
import type { ProviderResponseContext } from '../provider-response.js';
import type { DocumentPart, StreamChunk } from '../types.js';
import { inspectRecord, readValue } from '../validation-helpers.js';

export interface OpenAIInputFilePart {
  type: 'input_file';
  file_data?: string;
  file_url?: string;
  filename?: string;
}

/** Forward files to OpenAI without fetching document URLs in this process. */
export function translateOpenAIDocument(
  part: DocumentPart,
): OpenAIInputFilePart {
  const fields = inspectRecord(
    part,
    {
      code: 'invalid_openai_document',
      message: 'Invalid OpenAI document input.',
      option: 'document',
      provider: 'openai',
    },
    'document',
    ['type', 'mediaType', 'data', 'url', 'title', 'cacheControl'],
  );
  part = Object.fromEntries(
    Object.entries(fields).map(([key, descriptor]) => [key, descriptor.value]),
  ) as unknown as DocumentPart;
  const fail = (): never => {
    throw new ProviderCapabilityError(
      'OpenAI document input requires application/pdf and exactly one non-empty base64 data value or HTTPS URL.',
      { provider: 'openai' },
    );
  };
  if (
    part.mediaType !== 'application/pdf' ||
    (part.data !== undefined) === (part.url !== undefined) ||
    (readValue(fields, 'title') !== undefined &&
      (typeof part.title !== 'string' || !part.title.trim()))
  )
    fail();
  if (part.url !== undefined) {
    if (typeof part.url !== 'string' || !part.url.trim()) fail();
    let url: URL;
    try {
      url = new URL(part.url);
    } catch {
      return fail();
    }
    if (url.protocol !== 'https:' || url.username || url.password) fail();
    return { type: 'input_file', file_url: url.href };
  }
  if (
    typeof part.data !== 'string' ||
    part.data.length === 0 ||
    part.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
  )
    fail();
  return {
    type: 'input_file',
    filename: part.title ?? 'document.pdf',
    file_data: `data:application/pdf;base64,${part.data}`,
  };
}

export function validateOpenAIVerbosity(value: unknown, model: string): void {
  if (value === undefined) return;
  if (
    !['low', 'medium', 'high'].includes(value as string) ||
    !/^gpt-[56](?:[.-]|$)/.test(model)
  ) {
    throw new ProviderCapabilityError(
      'OpenAI verbosity must be low, medium, or high on a supported GPT-5 or GPT-6 model.',
      { provider: 'openai', model },
    );
  }
}

/** Only provider-authored summaries are exposed; encrypted/raw reasoning stays in raw. */
export function readOpenAIReasoningSummary(
  output: ReadonlyArray<{ type: string }> | undefined,
  context: ProviderResponseContext,
): string | undefined {
  const texts: string[] = [];
  for (const item of output ?? []) {
    if (item.type !== 'reasoning') continue;
    const summary = (item as Record<string, unknown>).summary;
    if (summary === undefined) continue;
    assertProviderArray(summary, context, 'reasoning.summary');
    for (const part of summary) {
      assertProviderObject(part, context, 'reasoning.summary.part');
      if (part.type !== 'summary_text') {
        throw invalidProviderResponse(context, {
          path: 'reasoning.summary.part.type',
          expected: 'summary_text',
          phase: 'schema',
        });
      }
      assertProviderString(part.text, context, 'reasoning.summary.part.text');
      if (part.text.length > 0) texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : undefined;
}

/** Track summary parts so final text/part events never duplicate streamed deltas. */
export class OpenAIReasoningSummaryStream {
  private readonly parts = new Map<string, { text: string; done: boolean }>();
  private active: string | undefined;

  *close(): Generator<StreamChunk> {
    if (this.active !== undefined) {
      this.active = undefined;
      yield { type: 'reasoning-end' };
    }
  }

  *consume(
    event: Record<string, unknown>,
    context: ProviderResponseContext,
  ): Generator<StreamChunk> {
    assertProviderString(event.item_id, context, 'event.item_id');
    for (const field of ['output_index', 'summary_index']) {
      if (
        typeof event[field] !== 'number' ||
        !Number.isSafeInteger(event[field]) ||
        (event[field] as number) < 0
      ) {
        throw invalidProviderResponse(context, {
          path: `event.${field}`,
          expected: 'non_negative_safe_integer',
          phase: 'schema',
        });
      }
    }
    const isDelta = event.type === 'response.reasoning_summary_text.delta';
    const done =
      event.type === 'response.reasoning_summary_text.done' ||
      event.type === 'response.reasoning_summary_part.done';
    let text: unknown;
    if (isDelta) text = event.delta;
    else if (event.type === 'response.reasoning_summary_text.done')
      text = event.text;
    else {
      assertProviderObject(event.part, context, 'event.part');
      if (event.part.type !== 'summary_text') {
        throw invalidProviderResponse(context, {
          path: 'event.part.type',
          expected: 'summary_text',
          phase: 'schema',
        });
      }
      text = event.part.text;
    }
    assertProviderString(text, context, 'event.summary_text');
    const key = JSON.stringify([event.item_id, event.summary_index]);
    const state = this.parts.get(key) ?? { text: '', done: false };
    if (
      (!isDelta && !text.startsWith(state.text)) ||
      (state.done && (isDelta || text !== state.text))
    ) {
      throw invalidProviderResponse(context, {
        path: 'event.summary_text',
        expected: 'consistent_summary_part',
        phase: 'stream',
      });
    }
    if (state.done) return;
    const delta = isDelta ? text : text.slice(state.text.length);
    if (this.active !== key && (!done || delta.length > 0)) {
      yield* this.close();
      this.active = key;
      yield { type: 'reasoning-start' };
    }
    state.text += delta;
    state.done = done;
    this.parts.set(key, state);
    if (delta.length > 0) yield { type: 'reasoning-delta', delta };
    if (done && this.active === key) yield* this.close();
  }
}
