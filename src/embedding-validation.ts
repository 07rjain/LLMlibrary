import { ProviderCapabilityError } from 'unified-llm-client/errors';
import { defaultModelPrices } from './models/prices.js';

import type {
  EmbeddingInputItem,
  EmbeddingProvider,
  EmbeddingRequestOptions,
  ModelInfo,
} from './types.js';

const PURPOSES = [
  'retrieval_document',
  'retrieval_query',
  'semantic_similarity',
  'classification',
  'clustering',
] as const;
const INPUT = 'embedding_input';

interface ValidationContext {
  model: string;
  modelInfo?: Pick<
    ModelInfo,
    'embeddingDimensions' | 'supportedInputModalities'
  >;
  provider: EmbeddingProvider;
}

type ValidationOptions = Pick<
  EmbeddingRequestOptions,
  'dimensions' | 'input' | 'providerOptions' | 'purpose'
>;

export function validateEmbeddingRequest(
  options: ValidationOptions,
  ctx: ValidationContext,
): EmbeddingInputItem[] {
  const { dimensions: d, purpose } = options;
  const info =
    ctx.modelInfo ??
    (
      defaultModelPrices as Record<
        string,
        | Pick<ModelInfo, 'embeddingDimensions' | 'supportedInputModalities'>
        | undefined
      >
    )[ctx.model];
  if (
    purpose !== undefined &&
    !(PURPOSES as readonly unknown[]).includes(purpose)
  ) {
    invalid(ctx, 'purpose', 'supported_embedding_purpose', {
      allowed: PURPOSES,
      value: purpose === null ? 'null' : typeof purpose,
    });
  }

  if (d !== undefined && (!Number.isInteger(d) || d <= 0)) {
    invalid(ctx, 'dimensions', 'finite_positive_integer', {
      value: String(d),
    });
  }

  const limits =
    ctx.provider === 'mock' ? undefined : info?.embeddingDimensions;
  if (
    d !== undefined &&
    ((limits?.min !== undefined && d < limits.min) ||
      (limits?.max !== undefined && d > limits.max))
  ) {
    invalid(ctx, 'dimensions', 'model_dimension_range', {
      max: limits?.max,
      min: limits?.min,
      value: d,
    });
  }

  if (
    options.providerOptions?.google?.title &&
    purpose !== 'retrieval_document'
  ) {
    invalid(ctx, 'title', 'document_title');
  }

  const input = options.input as unknown;
  const items =
    typeof input === 'string'
      ? [input]
      : !Array.isArray(input)
        ? [input]
        : input.length === 0
          ? []
          : input.every(isPart)
            ? [input]
            : input;
  if (items.length === 0) {
    invalid(ctx, 'input', INPUT);
  }

  const modes = info
    ? new Set(info.supportedInputModalities ?? ['text'])
    : undefined;
  for (const [i, item] of items.entries()) {
    if (typeof item === 'string') {
      if (item.trim().length === 0) {
        invalid(ctx, 'input', INPUT, { itemIndex: i });
      }
      continue;
    }
    if (!Array.isArray(item) || item.length === 0) {
      invalid(ctx, 'input', INPUT, { itemIndex: i });
    }

    let files = 0;
    for (const value of item as unknown[]) {
      const modality = partMode(value, ctx, i);
      if (modes && !modes.has(modality)) {
        invalid(ctx, 'input', INPUT, {
          itemIndex: i,
          value: modality,
        });
      }
      if (modality !== 'text' && ++files > 1) {
        invalid(ctx, 'input', INPUT, { itemIndex: i });
      }
    }
  }

  return items as EmbeddingInputItem[];
}

function isPart(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function partMode(
  value: unknown,
  ctx: ValidationContext,
  i: number,
): 'audio' | 'document' | 'image' | 'text' {
  if (!isPart(value)) {
    return invalid(ctx, 'input', INPUT, {
      itemIndex: i,
    });
  }

  const part = value as Record<string, unknown>;
  const text = (key: string): boolean =>
    typeof part[key] === 'string' && part[key].trim().length > 0;
  switch (part.type) {
    case 'text':
      if (text('text')) return 'text';
      break;
    case 'image_base64':
      if (text('data') && text('mediaType')) return 'image';
      break;
    case 'image_url':
      if (text('url')) return 'image';
      break;
    case 'audio':
    case 'document':
      if (text('mediaType') && (text('data') || text('url'))) {
        return part.type;
      }
      break;
    case 'tool_call':
    case 'tool_result':
      return invalid(ctx, 'input', INPUT, {
        itemIndex: i,
      });
  }
  return invalid(ctx, 'input', INPUT, {
    itemIndex: i,
  });
}

function invalid(
  ctx: ValidationContext,
  option: string,
  constraint: string,
  details: Record<string, unknown> = {},
): never {
  throw new ProviderCapabilityError('Invalid embedding.', {
    details: { constraint, option, ...details },
    model: ctx.model,
    provider: ctx.provider,
    statusCode: 400,
  });
}
