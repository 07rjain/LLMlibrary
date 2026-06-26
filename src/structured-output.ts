import { ProviderCapabilityError } from './errors.js';

import type {
  CanonicalJsonSchema,
  CanonicalMessage,
  CanonicalProvider,
  CanonicalResponse,
  JsonValue,
  ModelInfo,
  ResponseFormat,
} from './types.js';

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_NODES = 2_000;

const SUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'description',
  'enum',
  'items',
  'properties',
  'required',
  'type',
]);

interface SchemaStats {
  nodes: number;
}

export function assertResponseFormatSupported(
  model: ModelInfo,
  responseFormat: ResponseFormat | undefined,
  options: { stream?: boolean } = {},
): void {
  if (!responseFormat || responseFormat.type === 'text') {
    return;
  }

  if (responseFormat.type === 'json_object' && !model.supportsJsonObjectOutput) {
    throw new ProviderCapabilityError(
      `Model "${model.id}" does not support JSON object output.`,
      {
        model: model.id,
        provider: model.provider,
      },
    );
  }

  if (responseFormat.type === 'json_schema' && !model.supportsJsonSchemaOutput) {
    throw new ProviderCapabilityError(
      `Model "${model.id}" does not support JSON schema output.`,
      {
        model: model.id,
        provider: model.provider,
      },
    );
  }

  if (options.stream && !model.supportsStructuredOutputStreaming) {
    throw new ProviderCapabilityError(
      `Model "${model.id}" does not support structured-output streaming requests.`,
      {
        model: model.id,
        provider: model.provider,
      },
    );
  }
}

export function buildOpenAITextFormat(
  responseFormat: ResponseFormat | undefined,
  options: { messages: CanonicalMessage[]; system?: string },
): Record<string, unknown> | undefined {
  if (!responseFormat || responseFormat.type === 'text') {
    return undefined;
  }

  if (responseFormat.type === 'json_object') {
    assertOpenAIJsonInstruction(options);
    return {
      format: {
        type: 'json_object',
      },
    };
  }

  return {
    format: {
      name: responseFormat.name ?? 'structured_output',
      schema: normalizeStructuredSchema(responseFormat.schema, 'openai', {
        root: true,
        strict: responseFormat.strict ?? true,
      }),
      strict: responseFormat.strict ?? true,
      type: 'json_schema',
    },
  };
}

export function buildGeminiResponseFormat(
  responseFormat: ResponseFormat | undefined,
): Record<string, unknown> | undefined {
  if (!responseFormat || responseFormat.type === 'text') {
    return undefined;
  }

  if (responseFormat.type === 'json_object') {
    return {
      text: {
        mimeType: 'application/json',
      },
    };
  }

  return {
    text: {
      mimeType: 'application/json',
      schema: normalizeStructuredSchema(responseFormat.schema, 'google', {
        root: true,
      }),
    },
  };
}

export function buildAnthropicOutputConfig(
  responseFormat: ResponseFormat | undefined,
): Record<string, unknown> | undefined {
  if (!responseFormat || responseFormat.type === 'text') {
    return undefined;
  }

  if (responseFormat.type === 'json_object') {
    throw new ProviderCapabilityError(
      'Anthropic JSON object output is not supported without a schema. Use responseFormat: { type: "json_schema", ... }.',
      {
        provider: 'anthropic',
      },
    );
  }

  return {
    format: {
      schema: normalizeStructuredSchema(responseFormat.schema, 'anthropic', {
        root: true,
      }),
      type: 'json_schema',
    },
  };
}

export function parseStructuredOutput(
  response: CanonicalResponse,
  responseFormat: ResponseFormat | undefined,
): CanonicalResponse {
  if (!responseFormat || responseFormat.type === 'text') {
    return response;
  }

  if (response.structuredOutputStatus === 'refusal') {
    return {
      ...response,
      responseFormat: responseFormat.type,
    };
  }

  if (responseFormat.parse === false) {
    return {
      ...response,
      responseFormat: responseFormat.type,
      structuredOutputStatus: 'disabled',
    };
  }

  try {
    return {
      ...response,
      parsed: JSON.parse(response.text) as JsonValue,
      responseFormat: responseFormat.type,
      structuredOutputStatus: 'parsed',
    };
  } catch (error) {
    return {
      ...response,
      parseError: error instanceof Error ? error.message : String(error),
      responseFormat: responseFormat.type,
      structuredOutputStatus: 'parse_error',
    };
  }
}

export function normalizeStructuredSchema(
  schema: CanonicalJsonSchema,
  provider: CanonicalProvider,
  options: { root?: boolean; strict?: boolean } = {},
): Record<string, unknown> {
  assertSchemaLimits(schema);
  return normalizeSchemaNode(schema, provider, {
    depth: 0,
    path: '$',
    root: options.root ?? false,
    strict: options.strict ?? false,
  });
}

function assertOpenAIJsonInstruction(options: {
  messages: CanonicalMessage[];
  system?: string;
}): void {
  const text = [
    options.system,
    ...options.messages.flatMap((message) => messageTextSegments(message)),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  if (!text.includes('JSON')) {
    throw new ProviderCapabilityError(
      'OpenAI JSON object mode requires an instruction that includes the string "JSON".',
      {
        provider: 'openai',
      },
    );
  }
}

function messageTextSegments(message: CanonicalMessage): string[] {
  if (typeof message.content === 'string') {
    return [message.content];
  }

  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text);
}

function assertSchemaLimits(schema: CanonicalJsonSchema): void {
  const serialized = JSON.stringify(schema);
  if (serialized.length > MAX_SCHEMA_BYTES) {
    throw new ProviderCapabilityError(
      `Structured output schema exceeds ${MAX_SCHEMA_BYTES} bytes.`,
    );
  }

  walkSchema(schema, {
    nodes: 0,
  });
}

function walkSchema(
  schema: CanonicalJsonSchema,
  stats: SchemaStats,
  depth: number = 0,
): void {
  stats.nodes += 1;
  if (stats.nodes > MAX_SCHEMA_NODES) {
    throw new ProviderCapabilityError(
      `Structured output schema exceeds ${MAX_SCHEMA_NODES} nodes.`,
    );
  }

  if (depth > MAX_SCHEMA_DEPTH) {
    throw new ProviderCapabilityError(
      `Structured output schema exceeds depth ${MAX_SCHEMA_DEPTH}.`,
    );
  }

  if (schema.properties && Object.keys(schema.properties).length > MAX_SCHEMA_PROPERTIES) {
    throw new ProviderCapabilityError(
      `Structured output schema object exceeds ${MAX_SCHEMA_PROPERTIES} properties.`,
    );
  }

  for (const child of Object.values(schema.properties ?? {})) {
    walkSchema(child, stats, depth + 1);
  }

  if (schema.items) {
    walkSchema(schema.items, stats, depth + 1);
  }

  for (const child of schema.anyOf ?? []) {
    walkSchema(child, stats, depth + 1);
  }

  for (const child of schema.prefixItems ?? []) {
    walkSchema(child, stats, depth + 1);
  }

  for (const child of Object.values(schema.$defs ?? {})) {
    walkSchema(child, stats, depth + 1);
  }

  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object'
  ) {
    walkSchema(schema.additionalProperties, stats, depth + 1);
  }
}

function normalizeSchemaNode(
  schema: CanonicalJsonSchema,
  provider: CanonicalProvider,
  context: {
    depth: number;
    path: string;
    root: boolean;
    strict: boolean;
  },
): Record<string, unknown> {
  rejectUnsupportedSchemaKeys(schema, context.path);

  const type = normalizeSchemaType(schema.type, context.path);
  if (provider === 'openai' && context.root && type !== 'object') {
    throw new ProviderCapabilityError(
      'OpenAI JSON schema output requires a root object schema.',
      {
        provider,
      },
    );
  }

  const normalized: Record<string, unknown> = {};
  if (type !== undefined) {
    normalized.type = type;
  }

  if (schema.description !== undefined) {
    normalized.description = schema.description;
  }

  if (schema.enum !== undefined) {
    normalized.enum = schema.enum;
  }

  if (schema.items !== undefined) {
    normalized.items = normalizeSchemaNode(schema.items, provider, {
      ...context,
      depth: context.depth + 1,
      path: `${context.path}.items`,
      root: false,
    });
  }

  if (schema.properties !== undefined) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        normalizeSchemaNode(value, provider, {
          ...context,
          depth: context.depth + 1,
          path: `${context.path}.properties.${key}`,
          root: false,
        }),
      ]),
    );
    normalized.properties = properties;

    if (provider === 'openai' && (context.strict || context.root)) {
      normalized.required = Object.keys(schema.properties);
    } else if (schema.required !== undefined) {
      normalized.required = schema.required;
    }
  } else if (schema.required !== undefined) {
    normalized.required = schema.required;
  }

  if (isObjectSchemaType(type, schema.properties)) {
    if (provider === 'openai' && context.strict) {
      normalized.additionalProperties = false;
    } else if (typeof schema.additionalProperties === 'boolean') {
      normalized.additionalProperties = schema.additionalProperties;
    } else if (schema.additionalProperties !== undefined) {
      throw new ProviderCapabilityError(
        `Structured output schema at ${context.path} uses object additionalProperties, which is not supported in v1.`,
        {
          provider,
        },
      );
    }
  } else if (schema.additionalProperties !== undefined) {
    throw new ProviderCapabilityError(
      `Structured output schema at ${context.path} uses additionalProperties on a non-object schema.`,
      {
        provider,
      },
    );
  }

  return normalized;
}

function rejectUnsupportedSchemaKeys(
  schema: CanonicalJsonSchema,
  path: string,
): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new ProviderCapabilityError(
        `Structured output schema keyword "${key}" at ${path} is not supported in v1.`,
      );
    }
  }
}

function normalizeSchemaType(
  type: CanonicalJsonSchema['type'],
  path: string,
): string | undefined {
  if (Array.isArray(type)) {
    throw new ProviderCapabilityError(
      `Structured output schema union type at ${path} is not supported in v1.`,
    );
  }

  if (typeof type !== 'string') {
    return undefined;
  }

  if (type === 'null') {
    throw new ProviderCapabilityError(
      `Structured output schema null type at ${path} is not supported in v1.`,
    );
  }

  return type;
}

function isObjectSchemaType(
  type: string | undefined,
  properties: Record<string, CanonicalJsonSchema> | undefined,
): boolean {
  return type === 'object' || properties !== undefined;
}
